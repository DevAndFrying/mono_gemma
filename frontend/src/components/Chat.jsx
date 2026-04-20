import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './Chat.css';
import Message from './Message';
import InputArea from './InputArea';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const UPLOAD_BATCH_FILE_LIMIT = 25;
const UPLOAD_BATCH_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_REPO_FILE_BYTES = 20 * 1024 * 1024;
const PDF_FILE_EXTENSIONS = new Set(['.pdf']);
const IGNORED_REPO_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
  '__pycache__',
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.c',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.graphql',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mdx',
  '.php',
  '.prisma',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);
const TEXT_FILE_NAMES = new Set([
  '.dockerignore',
  '.env',
  '.env.example',
  '.gitignore',
  'Dockerfile',
  'Makefile',
  'README',
]);
const SAVED_CHATS_STORAGE_KEY = 'mcp-gemma-saved-chats';

const createChatTitle = (messages) => {
  const firstUserMessage = messages.find(message => message.role === 'user' && message.content?.trim());
  if (!firstUserMessage) {
    return `Chat ${new Date().toLocaleString()}`;
  }
  const cleaned = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
};

const loadSavedChats = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_CHATS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const persistSavedChats = (chats) => {
  localStorage.setItem(SAVED_CHATS_STORAGE_KEY, JSON.stringify(chats));
};

const downloadFile = (filename, content, type) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const serializeChatAsMarkdown = (messages) => {
  const lines = [
    '# MCP Gemma Chat Export',
    '',
    `Exported: ${new Date().toISOString()}`,
    '',
  ];

  messages.forEach((message, index) => {
    lines.push(`## ${index + 1}. ${message.role}`);
    lines.push('');
    lines.push(message.content || '');
    if (message.sources?.length) {
      lines.push('');
      lines.push('Sources:');
      message.sources.forEach((source) => {
        lines.push(`- [${source.index}] ${source.filePath || source.fileName || 'Source'}${source.sourceUrl ? ` (${source.sourceUrl})` : ''}`);
      });
    }
    lines.push('');
  });

  return lines.join('\n');
};

function Chat({ connected, selectedModel, onModelResolved, weaviateInfo }) {
  const [messages, setMessages] = useState([]);
  const [savedChats, setSavedChats] = useState(() => loadSavedChats());
  const [activeSavedChatId, setActiveSavedChatId] = useState('');
  const [chatStatus, setChatStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const hasShownModelLoadingRef = useRef(false);
  const chatStatusTimeoutRef = useRef(null);
  const reconnectAfterCloseRef = useRef(false);

  const replaceLastUploadStatus = (message) => {
    setMessages(prev => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (
        lastMsg?.role === 'assistant'
        && (lastMsg.content?.startsWith('Uploading ') || lastMsg.content?.startsWith('Preparing '))
      ) {
        updated[updated.length - 1] = message;
        return updated;
      }
      return [...updated, message];
    });
  };

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.VITE_WS_URL
      || (
        window.location.port === '5173'
          ? `${protocol}//${window.location.hostname}:3002`
          : `${protocol}//${window.location.host}`
      );

    console.log('Connecting WebSocket to:', wsUrl);
    console.log('   Frontend URL:', window.location.href);

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log('WebSocket connected (state: OPEN)');
        wsRef.current.isConnected = true;
        setWsConnected(true);
      };

      wsRef.current.onmessage = (event) => {
        console.log('WebSocket message received:', event.data.substring(0, 100));
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'thinking') {
            // Clear loading timeout - model already responding
            if (wsRef.current?.loadingTimeout) {
              clearTimeout(wsRef.current.loadingTimeout);
            }
            
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  thinking: (lastMsg.thinking || '') + data.payload.text,
                  hasStarted: true,
                  showLoading: false,
                };
              }
              return updated;
            });
          } else if (data.type === 'model') {
            if (data.payload?.fallback && data.payload?.model) {
              onModelResolved?.(data.payload.model);
            }
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  modelNotice: `Using ${data.payload.model} because ${data.payload.requestedModel || 'the requested model'} is not installed.`,
                };
              }
              return updated;
            });
          } else if (data.type === 'context') {
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  sources: data.payload?.sources || [],
                  contextClassName: data.payload?.className,
                };
              }
              return updated;
            });
          } else if (data.type === 'stream') {
            // Clear loading timeout - model already responding
            if (wsRef.current?.loadingTimeout) {
              clearTimeout(wsRef.current.loadingTimeout);
            }
            
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  content: `${lastMsg.modelNotice ? `${lastMsg.modelNotice}\n\n` : ''}${(lastMsg.content || '').replace(`${lastMsg.modelNotice || ''}\n\n`, '')}${data.payload.text}`,
                  hasStarted: true,
                  showLoading: false,
                };
              }
              return updated;
            });
          } else if (data.type === 'complete') {
            // Clear loading timeout
            if (wsRef.current?.loadingTimeout) {
              clearTimeout(wsRef.current.loadingTimeout);
            }
            
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  thinking: data.payload.thinking || lastMsg.thinking || '',
                  complete: true,
                  showLoading: false,
                };
              }
              return updated;
            });
            setLoading(false);
          } else if (data.type === 'error') {
            console.error('Error from backend:', data.payload.error);
            setMessages(prev => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMsg,
                  content: `Error: ${data.payload.error}`,
                  complete: true,
                  showLoading: false,
                };
              }
              return updated;
            });
            setLoading(false);
          }
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        console.error('   State after error:', wsRef.current?.readyState);
      };

      wsRef.current.onclose = (event) => {
        console.log('WebSocket closed (state: CLOSED)');
        console.log('   Code:', event.code, 'Reason:', event.reason);
        if (wsRef.current) {
          wsRef.current.isConnected = false;
        }
        setWsConnected(false);
        if (reconnectAfterCloseRef.current) {
          reconnectAfterCloseRef.current = false;
          window.setTimeout(connectWebSocket, 250);
        }
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
    }
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        console.log('Cleaning up WebSocket...');
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const showChatStatus = (status) => {
    setChatStatus(status);
    window.clearTimeout(chatStatusTimeoutRef.current);
    chatStatusTimeoutRef.current = window.setTimeout(() => setChatStatus(''), 3000);
  };

  const handleSaveChat = () => {
    if (messages.length === 0) {
      showChatStatus('No messages to save.');
      return;
    }

    const now = new Date().toISOString();
    const id = activeSavedChatId || `chat-${Date.now()}`;
    const savedChat = {
      id,
      title: createChatTitle(messages),
      model: selectedModel,
      updatedAt: now,
      messages,
    };
    const nextChats = [
      savedChat,
      ...savedChats.filter(chat => chat.id !== id),
    ].slice(0, 50);

    persistSavedChats(nextChats);
    setSavedChats(nextChats);
    setActiveSavedChatId(id);
    showChatStatus('Chat saved.');
  };

  const handleLoadChat = (chatId) => {
    setActiveSavedChatId(chatId);
    if (!chatId) {
      return;
    }
    const savedChat = savedChats.find(chat => chat.id === chatId);
    if (!savedChat) {
      showChatStatus('Saved chat not found.');
      return;
    }
    setMessages(savedChat.messages || []);
    if (savedChat.model) {
      onModelResolved?.(savedChat.model);
    }
    showChatStatus('Chat loaded.');
  };

  const handleNewChat = () => {
    setMessages([]);
    setActiveSavedChatId('');
    showChatStatus('Started a new chat.');
  };

  const handleDeleteSavedChat = () => {
    if (!activeSavedChatId) {
      showChatStatus('Select a saved chat first.');
      return;
    }
    const nextChats = savedChats.filter(chat => chat.id !== activeSavedChatId);
    persistSavedChats(nextChats);
    setSavedChats(nextChats);
    setActiveSavedChatId('');
    showChatStatus('Saved chat deleted.');
  };

  const handleExportChat = (format) => {
    if (messages.length === 0) {
      showChatStatus('No messages to export.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'json') {
      downloadFile(
        `mcp-gemma-chat-${timestamp}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), model: selectedModel, messages }, null, 2),
        'application/json'
      );
    } else {
      downloadFile(
        `mcp-gemma-chat-${timestamp}.md`,
        serializeChatAsMarkdown(messages),
        'text/markdown'
      );
    }
    showChatStatus(`Exported ${format.toUpperCase()}.`);
  };

  const handleSendMessage = async (text, className, useWeaviateContext = true) => {
    if (!text.trim() || !connected || !wsConnected) {
      if (!wsConnected) {
        console.warn('WebSocket not connected yet. Try again in a moment.');
      }
      return;
    }

    // Add user message and assistant placeholder atomically
    const userMessage = { role: 'user', content: text };
    const assistantPlaceholder = { role: 'assistant', content: '', showLoading: false, hasStarted: false };
    setMessages(prev => [...prev, userMessage, assistantPlaceholder]);
    setActiveSavedChatId('');
    setLoading(true);

    // Show the model-loading notice once, after 2 seconds if no response yet.
    const loadingTimeout = setTimeout(() => {
      if (hasShownModelLoadingRef.current) {
        return;
      }

      setMessages(prev => {
        const updated = [...prev];
        const lastMsg = updated[updated.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.hasStarted) {
          hasShownModelLoadingRef.current = true;
          updated[updated.length - 1] = {
            ...lastMsg,
            showLoading: true,
          };
        }
        return updated;
      });
    }, 2000);

    // Send via WebSocket
    if (wsRef.current && wsConnected) {
      console.log('Sending message via WebSocket:', text.substring(0, 50));
      
      // Store timeout so we can clear it when response arrives
      wsRef.current.loadingTimeout = loadingTimeout;
      
      wsRef.current.send(
        JSON.stringify({
          type: 'message',
          payload: { text, className, model: selectedModel, useWeaviateContext },
        })
      );
    } else {
      console.error('WebSocket not connected (wsConnected:', wsConnected, ')');
      clearTimeout(loadingTimeout);
      setLoading(false);
      setMessages(prev => {
        const updated = [...prev];
        updated.pop(); // Remove assistant placeholder
        updated.push({
          role: 'error',
          content: 'WebSocket not connected. Please wait for the connection to establish or refresh the page.',
        });
        return updated;
      });
    }
  };

  const handleStopChat = () => {
    if (!loading) {
      return;
    }

    if (wsRef.current?.loadingTimeout) {
      clearTimeout(wsRef.current.loadingTimeout);
    }

    reconnectAfterCloseRef.current = true;
    setLoading(false);
    setMessages(prev => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg?.role === 'assistant') {
        updated[updated.length - 1] = {
          ...lastMsg,
          content: lastMsg.content || 'Response stopped.',
          complete: true,
          stopped: true,
          showLoading: false,
        };
      }
      return updated;
    });

    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.close(4000, 'Stopped by user');
    } else {
      connectWebSocket();
    }
  };

  const extractPdfText = async (file) => {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) {
        pages.push(`Page ${pageNumber}\n${pageText}`);
      }
    }

    return pages.join('\n\n');
  };

  const isPdfFile = (file) => {
    const path = getFilePath(file);
    const fileName = path.split('/').pop() || file.name;
    return file.type === 'application/pdf' || PDF_FILE_EXTENSIONS.has(getFileExtension(fileName));
  };

  const extractFileText = async (file) => {
    const isPdf = isPdfFile(file);
    if (isPdf) {
      return extractPdfText(file);
    }
    return file.text();
  };

  const getFilePath = (file) => file.webkitRelativePath || file.relativePath || file.name;

  const getFileExtension = (fileName) => {
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
  };

  const isTextLikeFile = (file) => {
    const path = getFilePath(file);
    const fileName = path.split('/').pop() || file.name;
    return (
      file.type.startsWith('text/')
      || file.type === 'application/json'
      || file.type === 'application/xml'
      || file.type === 'application/x-yaml'
      || TEXT_FILE_EXTENSIONS.has(getFileExtension(fileName))
      || TEXT_FILE_NAMES.has(fileName)
    );
  };

  const isSupportedUploadFile = (file) => isPdfFile(file) || isTextLikeFile(file);

  const shouldSkipRepoFile = (file) => {
    const path = getFilePath(file);
    const parts = path.split('/').filter(Boolean);
    const ignoredDirectory = parts.slice(0, -1).find(part => IGNORED_REPO_DIRECTORIES.has(part));
    if (ignoredDirectory) {
      return `ignored directory "${ignoredDirectory}"`;
    }
    if (file.size > MAX_REPO_FILE_BYTES) {
      return `larger than ${Math.round(MAX_REPO_FILE_BYTES / 1024 / 1024)} MB`;
    }
    if (!isSupportedUploadFile(file)) {
      return 'not a supported PDF, text, or code file';
    }
    return '';
  };

  const prepareUploadFiles = async (files, source) => {
    const skipped = [];
    const candidateFiles = source === 'repo'
      ? files.filter((file) => {
          const reason = shouldSkipRepoFile(file);
          if (reason) {
            skipped.push({ name: getFilePath(file), reason });
            return false;
          }
          return true;
        })
      : files;

    const prepared = [];
    for (const file of candidateFiles) {
      try {
        const content = await extractFileText(file);
        if (!content.trim()) {
          skipped.push({ name: getFilePath(file), reason: 'no readable text content' });
          continue;
        }
        prepared.push({
          name: file.name,
          path: getFilePath(file),
          type: file.type || 'text/plain',
          size: file.size,
          content,
        });
      } catch (error) {
        skipped.push({ name: getFilePath(file), reason: error.message });
      }
    }

    return { prepared, skipped };
  };

  const createUploadBatches = (files) => {
    const batches = [];
    let currentBatch = [];
    let currentBytes = 0;

    files.forEach((file) => {
      const fileBytes = new TextEncoder().encode(file.content).length;
      const shouldStartNewBatch = currentBatch.length > 0 && (
        currentBatch.length >= UPLOAD_BATCH_FILE_LIMIT
        || currentBytes + fileBytes > UPLOAD_BATCH_BYTE_LIMIT
      );

      if (shouldStartNewBatch) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBytes = 0;
      }

      currentBatch.push(file);
      currentBytes += fileBytes;
    });

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  };

  const handleUploadFiles = async (files, className, options = {}) => {
    if (!connected || uploading || weaviateInfo?.status !== 'ready') {
      replaceLastUploadStatus({
        role: 'error',
        content: weaviateInfo?.error || 'Weaviate is not ready for uploads.',
      });
      return;
    }

    const source = options.source || 'files';
    setUploading(true);
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Preparing ${files.length} ${source === 'repo' ? 'repo file' : 'file'}${files.length === 1 ? '' : 's'} for Weaviate...`,
      },
    ]);

    try {
      const { prepared, skipped } = await prepareUploadFiles(files, source);
      if (prepared.length === 0) {
        throw new Error(`No supported files found. Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}.`);
      }

      const batches = createUploadBatches(prepared);
      const uploaded = [];
      const skippedDuplicates = [];
      let uploadedClassName = className || 'UploadedFile';

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        replaceLastUploadStatus({
          role: 'assistant',
          content: `Uploading batch ${batchIndex + 1} of ${batches.length} to Weaviate (${uploaded.length}/${prepared.length} files done)...`,
        });

        const response = await fetch('/api/weaviate/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            className,
            files: batch,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Upload failed');
        }
        uploadedClassName = data.className || uploadedClassName;
        uploaded.push(...data.uploaded);
        skippedDuplicates.push(...(data.skippedDuplicates || []));
      }

      const uploadedNames = uploaded.slice(0, 8).map(file => file.filePath || file.fileName).join(', ');
      const moreUploaded = uploaded.length > 8 ? `, and ${uploaded.length - 8} more` : '';
      const skippedText = skipped.length ? ` Skipped ${skipped.length} unsupported/generated file${skipped.length === 1 ? '' : 's'}.` : '';
      const duplicateText = skippedDuplicates.length ? ` Skipped ${skippedDuplicates.length} duplicate file${skippedDuplicates.length === 1 ? '' : 's'} already in Weaviate.` : '';
      replaceLastUploadStatus({
        role: 'assistant',
        content: `Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} to ${uploadedClassName}${uploaded.length ? `: ${uploadedNames}${moreUploaded}` : ''}.${duplicateText}${skippedText}`,
      });
    } catch (error) {
      replaceLastUploadStatus({
        role: 'error',
        content: `Weaviate upload failed: ${error.message}`,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-toolbar">
        <div className="saved-chat-controls">
          <select
            className="saved-chat-select"
            value={activeSavedChatId}
            onChange={(event) => handleLoadChat(event.target.value)}
            title="Load saved chat"
          >
            <option value="">Saved chats</option>
            {savedChats.map(chat => (
              <option key={chat.id} value={chat.id}>
                {chat.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleSaveChat} disabled={messages.length === 0}>
            Save chat
          </button>
          <button type="button" onClick={handleNewChat} disabled={messages.length === 0 && !activeSavedChatId}>
            New chat
          </button>
          <button type="button" onClick={handleDeleteSavedChat} disabled={!activeSavedChatId}>
            Delete saved
          </button>
        </div>
        <div className="export-chat-controls">
          <button type="button" onClick={() => handleExportChat('markdown')} disabled={messages.length === 0}>
            Export MD
          </button>
          <button type="button" onClick={() => handleExportChat('json')} disabled={messages.length === 0}>
            Export JSON
          </button>
          {chatStatus && <span className="chat-toolbar-status">{chatStatus}</span>}
        </div>
      </div>
      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">AI</div>
            <h2>Welcome to MCP Gemma Chat</h2>
            <p>Start a conversation with the Gemma model</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <Message
            key={idx}
            role={msg.role}
            content={msg.content}
            thinking={msg.thinking}
            showLoading={msg.showLoading}
            sources={msg.sources}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <InputArea
        onSendMessage={handleSendMessage}
        onStopChat={handleStopChat}
        onUploadFiles={handleUploadFiles}
        disabled={!connected || loading || !wsConnected || uploading}
        uploadDisabled={!connected || uploading || weaviateInfo?.status !== 'ready'}
        uploadStatus={weaviateInfo}
        loading={loading}
        uploadLoading={uploading}
      />
    </div>
  );
}

export default Chat;
