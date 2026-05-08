import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
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
const POWERPOINT_FILE_EXTENSIONS = new Set(['.pptx']);
const POWERPOINT_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
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
const SELECTED_CONTEXT_COLLECTIONS_STORAGE_KEY = 'mcp-gemma-context-collections';
const UPLOAD_COLLECTION_STORAGE_KEY = 'mcp-gemma-upload-collection';
const DEFAULT_WEAVIATE_COLLECTION = 'uploaded_files';
const AUTO_SAVE_DELAY_MS = 700;

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

const loadStoredString = (key, fallback = '') => {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};

const loadStoredArray = (key, fallback = []) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item.trim()) : fallback;
  } catch {
    return fallback;
  }
};

const readJsonResponse = async (response) => {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const details = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(details || `Server returned a non-JSON response with status ${response.status}.`);
  }
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

const isNearScrollBottom = (element, threshold = 80) => (
  element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
);

const scrollToBottom = (element) => {
  if (element) {
    element.scrollTop = element.scrollHeight;
  }
};

function Chat({ connected, selectedModel, onModelResolved, weaviateInfo }) {
  const [messages, setMessages] = useState([]);
  const [savedChats, setSavedChats] = useState(() => loadSavedChats());
  const [activeSavedChatId, setActiveSavedChatId] = useState('');
  const [chatStatus, setChatStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [collapseSourcesSignal, setCollapseSourcesSignal] = useState(0);
  const [showDeleteChatConfirm, setShowDeleteChatConfirm] = useState(false);
  const [collections, setCollections] = useState([]);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [selectedUploadCollection, setSelectedUploadCollection] = useState(() => loadStoredString(UPLOAD_COLLECTION_STORAGE_KEY, DEFAULT_WEAVIATE_COLLECTION));
  const [selectedContextCollections, setSelectedContextCollections] = useState(() => loadStoredArray(SELECTED_CONTEXT_COLLECTIONS_STORAGE_KEY, [DEFAULT_WEAVIATE_COLLECTION]));
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const deleteChatConfirmRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const hasShownModelLoadingRef = useRef(false);
  const chatStatusTimeoutRef = useRef(null);
  const autoSaveTimeoutRef = useRef(null);
  const skipNextAutoSaveRef = useRef(false);
  const reconnectAfterCloseRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const lastTouchYRef = useRef(null);
  const pendingStreamTextRef = useRef('');
  const pendingThinkingTextRef = useRef('');
  const streamFlushTimeoutRef = useRef(null);

  const flushAssistantStreamChunks = () => {
    if (streamFlushTimeoutRef.current) {
      window.clearTimeout(streamFlushTimeoutRef.current);
      streamFlushTimeoutRef.current = null;
    }

    const streamText = pendingStreamTextRef.current;
    const thinkingText = pendingThinkingTextRef.current;
    pendingStreamTextRef.current = '';
    pendingThinkingTextRef.current = '';

    if (!streamText && !thinkingText) {
      return;
    }

    setMessages(prev => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        const modelNoticePrefix = lastMsg.modelNotice ? `${lastMsg.modelNotice}\n\n` : '';
        const contentWithoutNotice = modelNoticePrefix
          ? (lastMsg.content || '').replace(modelNoticePrefix, '')
          : (lastMsg.content || '');

        updated[updated.length - 1] = {
          ...lastMsg,
          thinking: `${lastMsg.thinking || ''}${thinkingText}`,
          content: streamText
            ? `${modelNoticePrefix}${contentWithoutNotice}${streamText}`
            : lastMsg.content,
          hasStarted: lastMsg.hasStarted || Boolean(streamText || thinkingText),
          showLoading: streamText || thinkingText ? false : lastMsg.showLoading,
        };
      }
      return updated;
    });
  };

  const scheduleAssistantStreamFlush = () => {
    if (streamFlushTimeoutRef.current) {
      return;
    }

    streamFlushTimeoutRef.current = window.setTimeout(flushAssistantStreamChunks, 50);
  };

  const appendAssistantStreamChunk = (text) => {
    pendingStreamTextRef.current += text;
    scheduleAssistantStreamFlush();
  };

  const appendAssistantThinkingChunk = (text) => {
    pendingThinkingTextRef.current += text;
    scheduleAssistantStreamFlush();
  };

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

  const refreshCollections = async () => {
    if (weaviateInfo?.status !== 'ready') {
      return;
    }

    setCollectionLoading(true);
    try {
      const response = await fetch('/api/weaviate/collections');
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load Weaviate collections');
      }

      const defaultCollection = data.defaultCollection || DEFAULT_WEAVIATE_COLLECTION;
      const nextCollections = Array.isArray(data.collections) ? data.collections : [];
      const activeCollections = nextCollections
        .filter(collection => collection?.name)
        .sort((left, right) => left.name.localeCompare(right.name));
      const activeNames = new Set(activeCollections.map(collection => collection.name));
      const fallbackCollection = activeCollections[0]?.name || defaultCollection;

      setCollections(activeCollections);
      setSelectedUploadCollection(current => (current && activeNames.has(current) ? current : fallbackCollection));
      setSelectedContextCollections(current => {
        const validSelections = current.filter(name => activeNames.has(name));
        if (validSelections.length) {
          return validSelections;
        }
        return activeCollections.length ? [fallbackCollection] : [];
      });
    } catch (error) {
      console.error('Failed to refresh Weaviate collections:', error);
      showChatStatus(error.message);
    } finally {
      setCollectionLoading(false);
    }
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

            appendAssistantThinkingChunk(data.payload.text || '');
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

            appendAssistantStreamChunk(data.payload.text || '');
          } else if (data.type === 'complete') {
            // Clear loading timeout
            if (wsRef.current?.loadingTimeout) {
              clearTimeout(wsRef.current.loadingTimeout);
            }

            flushAssistantStreamChunks();
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
            flushAssistantStreamChunks();
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
      if (streamFlushTimeoutRef.current) {
        window.clearTimeout(streamFlushTimeoutRef.current);
      }
      if (wsRef.current) {
        console.log('Cleaning up WebSocket...');
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    refreshCollections();
  }, [weaviateInfo?.status]);

  useEffect(() => {
    if (weaviateInfo?.status !== 'ready') {
      setCollections([]);
      setSelectedContextCollections([]);
      return undefined;
    }

    const intervalId = window.setInterval(refreshCollections, 15000);
    const handleFocus = () => {
      refreshCollections();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
    };
  }, [weaviateInfo?.status]);

  useEffect(() => {
    localStorage.setItem(UPLOAD_COLLECTION_STORAGE_KEY, selectedUploadCollection);
  }, [selectedUploadCollection]);

  useEffect(() => {
    localStorage.setItem(SELECTED_CONTEXT_COLLECTIONS_STORAGE_KEY, JSON.stringify(selectedContextCollections));
  }, [selectedContextCollections]);

  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      scrollToBottom(messagesAreaRef.current);
    }
  }, [messages]);

  useEffect(() => {
    if (!showDeleteChatConfirm) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!deleteChatConfirmRef.current?.contains(event.target)) {
        setShowDeleteChatConfirm(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setShowDeleteChatConfirm(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showDeleteChatConfirm]);

  useEffect(() => {
    window.clearTimeout(autoSaveTimeoutRef.current);
    if (messages.length === 0) {
      return undefined;
    }
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return undefined;
    }

    autoSaveTimeoutRef.current = window.setTimeout(() => {
      saveChatSnapshot(messages);
    }, AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(autoSaveTimeoutRef.current);
  }, [messages, selectedModel, activeSavedChatId]);

  const showChatStatus = (status) => {
    setChatStatus(status);
    window.clearTimeout(chatStatusTimeoutRef.current);
    chatStatusTimeoutRef.current = window.setTimeout(() => setChatStatus(''), 3000);
  };

  const saveChatSnapshot = (chatMessages, { showStatus = false } = {}) => {
    if (chatMessages.length === 0) {
      if (showStatus) {
        showChatStatus('No messages to save.');
      }
      return '';
    }

    const now = new Date().toISOString();
    const id = activeSavedChatId || `chat-${Date.now()}`;
    setSavedChats(prevChats => {
      const existingChat = prevChats.find(chat => chat.id === id);
      const savedChat = {
        id,
        title: existingChat?.title || createChatTitle(chatMessages),
        model: selectedModel,
        updatedAt: now,
        messages: chatMessages,
      };
      const nextChats = [
        savedChat,
        ...prevChats.filter(chat => chat.id !== id),
      ].slice(0, 50);
      persistSavedChats(nextChats);
      return nextChats;
    });
    if (activeSavedChatId !== id) {
      setActiveSavedChatId(id);
    }
    if (showStatus) {
      showChatStatus('Chat saved.');
    }
    return id;
  };

  const handleSaveChat = () => {
    saveChatSnapshot(messages, { showStatus: true });
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

  const handleRenameSavedChat = () => {
    if (!activeSavedChatId) {
      showChatStatus('Select a saved chat first.');
      return;
    }

    const savedChat = savedChats.find(chat => chat.id === activeSavedChatId);
    if (!savedChat) {
      showChatStatus('Saved chat not found.');
      return;
    }

    const title = window.prompt('Rename saved chat', savedChat.title || '');
    if (title === null) {
      return;
    }

    const trimmedTitle = title.replace(/\s+/g, ' ').trim();
    if (!trimmedTitle) {
      showChatStatus('Enter a chat name first.');
      return;
    }

    setSavedChats(prevChats => {
      const nextChats = prevChats.map(chat => (
        chat.id === activeSavedChatId
          ? { ...chat, title: trimmedTitle }
          : chat
      ));
      persistSavedChats(nextChats);
      return nextChats;
    });
    showChatStatus('Chat renamed.');
  };

  const handleDeleteSavedChat = () => {
    if (!activeSavedChatId) {
      showChatStatus('Select a saved chat first.');
      return;
    }
    const nextChats = savedChats.filter(chat => chat.id !== activeSavedChatId);
    persistSavedChats(nextChats);
    skipNextAutoSaveRef.current = true;
    setSavedChats(nextChats);
    setMessages([]);
    setActiveSavedChatId('');
    setShowDeleteChatConfirm(false);
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

  const handleSendMessage = async (text, classNames, useWeaviateContext = true, generationOptions = {}) => {
    if (!text.trim() || !connected || !wsConnected) {
      if (!wsConnected) {
        console.warn('WebSocket not connected yet. Try again in a moment.');
      }
      return;
    }

    // Add user message and assistant placeholder atomically
    const userMessage = { role: 'user', content: text };
    const assistantPlaceholder = { role: 'assistant', content: '', showLoading: false, hasStarted: false };
    flushAssistantStreamChunks();
    pendingStreamTextRef.current = '';
    pendingThinkingTextRef.current = '';
    shouldStickToBottomRef.current = true;
    setMessages(prev => [...prev, userMessage, assistantPlaceholder]);
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
          payload: {
            text,
            classNames: Array.isArray(classNames) ? classNames : [classNames].filter(Boolean),
            model: selectedModel,
            useWeaviateContext,
            temperature: generationOptions.temperature,
            top_p: generationOptions.top_p,
            contextChars: generationOptions.contextChars,
          },
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

  const handleMessagesScroll = (event) => {
    shouldStickToBottomRef.current = isNearScrollBottom(event.currentTarget);
  };

  const handleMessagesWheel = (event) => {
    if (event.deltaY < 0) {
      shouldStickToBottomRef.current = false;
      return;
    }

    if (event.deltaY > 0) {
      shouldStickToBottomRef.current = isNearScrollBottom(event.currentTarget);
    }
  };

  const handleMessagesTouchStart = (event) => {
    lastTouchYRef.current = event.touches[0]?.clientY ?? null;
  };

  const handleMessagesTouchMove = (event) => {
    const currentY = event.touches[0]?.clientY;
    if (typeof currentY !== 'number' || typeof lastTouchYRef.current !== 'number') {
      return;
    }

    if (currentY > lastTouchYRef.current) {
      shouldStickToBottomRef.current = false;
    } else if (currentY < lastTouchYRef.current) {
      shouldStickToBottomRef.current = isNearScrollBottom(event.currentTarget);
    }
    lastTouchYRef.current = currentY;
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

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }

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

  const decodeXmlEntities = (text) => {
    const parser = new DOMParser();
    return parser.parseFromString(`<text>${text}</text>`, 'application/xml').documentElement.textContent || '';
  };

  const extractPowerPointText = async (file) => {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slideEntries = Object.values(zip.files)
      .filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort((first, second) => {
        const firstNumber = Number(first.name.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        const secondNumber = Number(second.name.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        return firstNumber - secondNumber;
      });

    const slides = [];
    for (const entry of slideEntries) {
      const xml = await entry.async('text');
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map(match => decodeXmlEntities(match[1]))
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');

      if (text) {
        const slideNumber = entry.name.match(/slide(\d+)\.xml$/i)?.[1];
        slides.push(`Slide ${slideNumber}\n${text}`);
      }
    }

    return slides.join('\n\n');
  };

  const isPdfFile = (file) => {
    const path = getFilePath(file);
    const fileName = path.split('/').pop() || file.name;
    return file.type === 'application/pdf' || PDF_FILE_EXTENSIONS.has(getFileExtension(fileName));
  };

  const isPowerPointFile = (file) => {
    const path = getFilePath(file);
    const fileName = path.split('/').pop() || file.name;
    return POWERPOINT_MIME_TYPES.has(file.type) || POWERPOINT_FILE_EXTENSIONS.has(getFileExtension(fileName));
  };

  const extractFileText = async (file) => {
    const isPdf = isPdfFile(file);
    if (isPdf) {
      return extractPdfText(file);
    }
    if (isPowerPointFile(file)) {
      return extractPowerPointText(file);
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

  const isSupportedUploadFile = (file) => isPdfFile(file) || isPowerPointFile(file) || isTextLikeFile(file);

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
      return 'not a supported PDF, PowerPoint, text, or code file';
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
      let uploadedClassName = className || DEFAULT_WEAVIATE_COLLECTION;

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

        const data = await readJsonResponse(response);
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

  const handleCreateCollection = async (rawCollectionName) => {
    const className = rawCollectionName.trim();
    if (!className) {
      return { ok: false, message: 'Enter a library name first.' };
    }

    setCollectionLoading(true);
    try {
      const response = await fetch('/api/weaviate/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className }),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create Weaviate library');
      }

      const collection = data.collection || { name: className };
      setCollections(currentCollections => {
        const byName = new Map(currentCollections.map(item => [item.name, item]));
        byName.set(collection.name, collection);
        return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
      });
      setSelectedUploadCollection(collection.name);
      setSelectedContextCollections(current => (
        current.includes(collection.name) ? current : [...current, collection.name]
      ));
      return { ok: true, collection, message: `Created ${collection.name}.` };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      setCollectionLoading(false);
    }
  };

  const handleDeleteCollection = async (className) => {
    const collectionName = className?.trim();
    if (!collectionName) {
      showChatStatus('Select a library to delete first.');
      return;
    }

    const confirmed = window.confirm(
      `Delete expert library "${collectionName}" and all files stored in it? This cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    setCollectionLoading(true);
    try {
      const response = await fetch(`/api/weaviate/collections/${encodeURIComponent(collectionName)}`, {
        method: 'DELETE',
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete Weaviate library');
      }

      const remainingCollections = collections
        .filter(collection => collection.name !== collectionName)
        .sort((left, right) => left.name.localeCompare(right.name));
      const fallbackCollection = remainingCollections[0]?.name || DEFAULT_WEAVIATE_COLLECTION;

      setCollections(remainingCollections);
      setSelectedUploadCollection(current => (current === collectionName ? fallbackCollection : current));
      setSelectedContextCollections(current => {
        const nextCollections = current.filter(name => name !== collectionName);
        return nextCollections.length ? nextCollections : (remainingCollections.length ? [fallbackCollection] : []);
      });
      showChatStatus(`Deleted ${data.deleted || collectionName}.`);
    } catch (error) {
      showChatStatus(error.message);
    } finally {
      setCollectionLoading(false);
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
          <button type="button" onClick={handleRenameSavedChat} disabled={!activeSavedChatId}>
            Rename chat
          </button>
          <div
            className="delete-chat-confirm-menu"
            ref={deleteChatConfirmRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setShowDeleteChatConfirm(false);
              }
            }}
          >
            <button
              type="button"
              onClick={() => setShowDeleteChatConfirm(current => !current)}
              disabled={!activeSavedChatId}
              aria-expanded={showDeleteChatConfirm}
            >
              Delete selected chat
            </button>
            {showDeleteChatConfirm && (
              <div className="delete-chat-confirm-popover">
                <span>Delete this saved chat?</span>
                <div className="delete-chat-confirm-actions">
                  <button type="button" className="delete-chat-confirm-cancel" onClick={() => setShowDeleteChatConfirm(false)}>
                    Cancel
                  </button>
                  <button type="button" className="delete-chat-confirm-delete" onClick={handleDeleteSavedChat}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
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
      <div
        className="messages-area"
        ref={messagesAreaRef}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onTouchStart={handleMessagesTouchStart}
        onTouchMove={handleMessagesTouchMove}
        onClick={() => setCollapseSourcesSignal(signal => signal + 1)}
      >
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
            collapseSourcesSignal={collapseSourcesSignal}
          />
        ))}
      </div>
      <InputArea
        onSendMessage={handleSendMessage}
        onStopChat={handleStopChat}
        onUploadFiles={handleUploadFiles}
        onCreateCollection={handleCreateCollection}
        onDeleteCollection={handleDeleteCollection}
        disabled={!connected || loading || !wsConnected || uploading}
        uploadDisabled={!connected || uploading || weaviateInfo?.status !== 'ready'}
        uploadStatus={weaviateInfo}
        loading={loading}
        uploadLoading={uploading}
        collections={collections}
        selectedUploadCollection={selectedUploadCollection}
        onUploadCollectionChange={setSelectedUploadCollection}
        selectedContextCollections={selectedContextCollections}
        onContextCollectionsChange={setSelectedContextCollections}
        collectionLoading={collectionLoading}
      />
    </div>
  );
}

export default Chat;
