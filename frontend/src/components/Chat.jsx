import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './Chat.css';
import Message from './Message';
import InputArea from './InputArea';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
    const htmlTitle = details.match(/<title>(.*?)<\/title>/i)?.[1]
      || details.match(/<h1>(.*?)<\/h1>/i)?.[1];
    if (htmlTitle || /^<!doctype html/i.test(details) || /^<html[\s>]/i.test(details)) {
      const status = response.status ? `${response.status} ` : '';
      throw new Error(`Server returned ${status}${htmlTitle || 'an HTML error page'} instead of JSON.`);
    }
    throw new Error(details || `Server returned a non-JSON response with status ${response.status}.`);
  }
};

const fetchSavedChats = async () => {
  const response = await fetch('/api/chats');
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load saved chats.');
  }
  return Array.isArray(data.chats) ? data.chats : [];
};

const saveChatToServer = async (chat) => {
  const response = await fetch(chat.id ? `/api/chats/${encodeURIComponent(chat.id)}` : '/api/chats', {
    method: chat.id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chat),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to save chat.');
  }
  return data.chat;
};

const renameChatOnServer = async (chatId, title) => {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to rename chat.');
  }
  return data.chat;
};

const deleteChatFromServer = async (chatId) => {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete chat.');
  }
  return data;
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

function Chat({
  connected,
  modelOptions = [],
  selectedModel,
  onModelChange,
  onModelResolved,
  installedModels = [],
  weaviateInfo,
}) {
  const [messages, setMessages] = useState([]);
  const [savedChats, setSavedChats] = useState([]);
  const [activeSavedChatId, setActiveSavedChatId] = useState('');
  const [chatStatus, setChatStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [collapseSourcesSignal, setCollapseSourcesSignal] = useState(0);
  const [showSavedChatActions, setShowSavedChatActions] = useState(false);
  const [showSavedChatsSidebar, setShowSavedChatsSidebar] = useState(true);
  const [savedChatsSidebarWidth, setSavedChatsSidebarWidth] = useState(260);
  const [collections, setCollections] = useState([]);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [selectedUploadCollection, setSelectedUploadCollection] = useState(() => loadStoredString(UPLOAD_COLLECTION_STORAGE_KEY, DEFAULT_WEAVIATE_COLLECTION));
  const [selectedContextCollections, setSelectedContextCollections] = useState(() => loadStoredArray(SELECTED_CONTEXT_COLLECTIONS_STORAGE_KEY, [DEFAULT_WEAVIATE_COLLECTION]));
  const [wsConnected, setWsConnected] = useState(false);
  const weaviateReady = weaviateInfo?.status === 'ready';
  const installedModelSet = new Set(installedModels || []);
  const wsRef = useRef(null);
  const savedChatActionsRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const hasShownModelLoadingRef = useRef(false);
  const chatStatusTimeoutRef = useRef(null);
  const autoSaveTimeoutRef = useRef(null);
  const skipNextAutoSaveRef = useRef(false);
  const reconnectAfterCloseRef = useRef(false);
  const activeSavedChatIdRef = useRef('');
  const savedChatsRef = useRef([]);
  const shouldStickToBottomRef = useRef(true);
  const lastTouchYRef = useRef(null);
  const pendingStreamTextRef = useRef('');
  const pendingThinkingTextRef = useRef('');
  const streamFlushTimeoutRef = useRef(null);
  const hasInitializedContextCollectionsRef = useRef(false);
  const sidebarResizeRef = useRef({ resizing: false, startX: 0, startWidth: 260 });

  const startSavedChatsSidebarResize = (event) => {
    event.preventDefault();
    sidebarResizeRef.current = {
      resizing: true,
      startX: event.clientX,
      startWidth: savedChatsSidebarWidth,
    };
    document.body.classList.add('resizing-saved-chats-sidebar');
  };

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
        if (!hasInitializedContextCollectionsRef.current && activeCollections.length > 0) {
          hasInitializedContextCollectionsRef.current = true;
          return activeCollections.map(collection => collection.name);
        }

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
    const handlePointerMove = (event) => {
      if (!sidebarResizeRef.current.resizing) {
        return;
      }

      const delta = event.clientX - sidebarResizeRef.current.startX;
      const nextWidth = Math.min(460, Math.max(30, sidebarResizeRef.current.startWidth + delta));
      setSavedChatsSidebarWidth(nextWidth);
    };

    const stopResize = () => {
      if (!sidebarResizeRef.current.resizing) {
        return;
      }
      sidebarResizeRef.current.resizing = false;
      document.body.classList.remove('resizing-saved-chats-sidebar');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      document.body.classList.remove('resizing-saved-chats-sidebar');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadServerChats = async () => {
      try {
        const serverChats = await fetchSavedChats();
        if (cancelled) {
          return;
        }

        if (serverChats.length > 0) {
          setSavedChats(serverChats);
          return;
        }

        const legacyChats = loadSavedChats();
        if (legacyChats.length === 0) {
          setSavedChats([]);
          return;
        }

        const migratedChats = [];
        for (const legacyChat of legacyChats.slice(0, 50)) {
          try {
            const savedChat = await saveChatToServer({
              id: legacyChat.id,
              title: legacyChat.title || createChatTitle(legacyChat.messages || []),
              model: legacyChat.model,
              messages: legacyChat.messages || [],
            });
            migratedChats.push(savedChat);
          } catch (error) {
            console.error('Failed to migrate saved chat:', error);
          }
        }

        if (!cancelled) {
          setSavedChats(migratedChats);
          if (migratedChats.length > 0) {
            localStorage.removeItem(SAVED_CHATS_STORAGE_KEY);
          }
        }
      } catch (error) {
        console.error('Failed to load saved chats:', error);
        if (!cancelled) {
          setSavedChats(loadSavedChats());
          showChatStatus(error.message);
        }
      }
    };

    loadServerChats();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    refreshCollections();
  }, [weaviateInfo?.status]);

  useEffect(() => {
    if (weaviateInfo?.status !== 'ready') {
      hasInitializedContextCollectionsRef.current = false;
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
    if (!showSavedChatActions) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!savedChatActionsRef.current?.contains(event.target)) {
        setShowSavedChatActions(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setShowSavedChatActions(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSavedChatActions]);

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
      saveChatSnapshot(messages, { reportErrors: true });
    }, AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(autoSaveTimeoutRef.current);
  }, [messages, selectedModel, activeSavedChatId]);

  useEffect(() => {
    activeSavedChatIdRef.current = activeSavedChatId;
  }, [activeSavedChatId]);

  useEffect(() => {
    savedChatsRef.current = savedChats;
  }, [savedChats]);

  const showChatStatus = (status) => {
    setChatStatus(status);
    window.clearTimeout(chatStatusTimeoutRef.current);
    chatStatusTimeoutRef.current = window.setTimeout(() => setChatStatus(''), 3000);
  };

  const saveChatSnapshot = async (chatMessages, { showStatus = false, reportErrors = false } = {}) => {
    if (chatMessages.length === 0) {
      if (showStatus) {
        showChatStatus('No messages to save.');
      }
      return '';
    }

    const id = activeSavedChatIdRef.current || '';
    const existingChat = savedChatsRef.current.find(chat => chat.id === id);
    try {
      const savedChat = await saveChatToServer({
        id,
        title: existingChat?.title || createChatTitle(chatMessages),
        model: selectedModel,
        messages: chatMessages,
      });

      setSavedChats(prevChats => [
        savedChat,
        ...prevChats.filter(chat => chat.id !== savedChat.id),
      ].slice(0, 50));
      if (activeSavedChatIdRef.current !== savedChat.id) {
        activeSavedChatIdRef.current = savedChat.id;
        setActiveSavedChatId(savedChat.id);
      }
      if (showStatus) {
        showChatStatus('Chat saved.');
      }
      return savedChat.id;
    } catch (error) {
      console.error('Failed to save chat:', error);
      if (showStatus || reportErrors) {
        showChatStatus(error.message);
      }
      return '';
    }
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
    skipNextAutoSaveRef.current = true;
    setMessages(savedChat.messages || []);
    if (savedChat.model) {
      onModelResolved?.(savedChat.model);
    }
    showChatStatus('Chat loaded.');
  };

  const handleNewChat = () => {
    setMessages([]);
    setActiveSavedChatId('');
    setShowSavedChatActions(false);
    showChatStatus('Started a new chat.');
  };

  const handleRenameSavedChat = async () => {
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

    try {
      const renamedChat = await renameChatOnServer(activeSavedChatId, trimmedTitle);
      setSavedChats(prevChats => prevChats.map(chat => (
        chat.id === activeSavedChatId ? renamedChat : chat
      )));
      setShowSavedChatActions(false);
      showChatStatus('Chat renamed.');
    } catch (error) {
      showChatStatus(error.message);
    }
  };

  const handleDeleteSavedChat = async () => {
    if (!activeSavedChatId) {
      showChatStatus('Select a saved chat first.');
      return;
    }
    const savedChat = savedChats.find(chat => chat.id === activeSavedChatId);
    const confirmed = window.confirm(`Delete "${savedChat?.title || 'this saved chat'}"?`);
    if (!confirmed) {
      return;
    }
    try {
      await deleteChatFromServer(activeSavedChatId);
      const nextChats = savedChats.filter(chat => chat.id !== activeSavedChatId);
      skipNextAutoSaveRef.current = true;
      setSavedChats(nextChats);
      setMessages([]);
      setActiveSavedChatId('');
      setShowSavedChatActions(false);
      showChatStatus('Saved chat deleted.');
    } catch (error) {
      showChatStatus(error.message);
    }
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

      const uploaded = [];
      const skippedDuplicates = [];
      let uploadedClassName = className || DEFAULT_WEAVIATE_COLLECTION;

      for (let fileIndex = 0; fileIndex < prepared.length; fileIndex += 1) {
        const file = prepared[fileIndex];
        let nextChunkIndex = 0;

        while (nextChunkIndex !== null) {
          const chunkText = nextChunkIndex > 0 ? `, continuing at chunk ${nextChunkIndex + 1}` : '';
          replaceLastUploadStatus({
            role: 'assistant',
            content: `Uploading ${fileIndex + 1} of ${prepared.length} to Weaviate: ${file.path || file.name}${chunkText}...`,
          });

          const response = await fetch('/api/weaviate/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              className,
              files: [file],
              startChunkIndex: nextChunkIndex,
            }),
          });

          const data = await readJsonResponse(response);
          if (!response.ok || data.error) {
            throw new Error(data.error || 'Upload failed');
          }
          uploadedClassName = data.className || uploadedClassName;
          skippedDuplicates.push(...(data.skippedDuplicates || []));

          if (data.skippedDuplicateCount > 0) {
            nextChunkIndex = null;
            break;
          }

          const uploadedFile = data.uploaded?.[0];
          if (!uploadedFile) {
            throw new Error('Upload did not return file progress.');
          }

          if (uploadedFile.complete === false && typeof uploadedFile.nextChunkIndex === 'number') {
            nextChunkIndex = uploadedFile.nextChunkIndex;
          } else {
            uploaded.push(uploadedFile);
            nextChunkIndex = null;
          }
        }
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

  const hasConversation = messages.length > 0;

  return (
    <div className={`chat-container ${hasConversation ? 'has-conversation' : 'empty-chat'}`}>
      <div className="chat-toolbar">
        <div className="saved-chat-controls">
          <h1 className="chat-toolbar-title">MCP Gemma Chat</h1>
          <label className="toolbar-model-picker" htmlFor="model-select">
            <span>Model</span>
            <select
              id="model-select"
              value={selectedModel}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={!connected || modelOptions.length === 0}
            >
              {modelOptions.length === 0 ? (
                <option value="">No models found</option>
              ) : (
                modelOptions.map(model => (
                  <option key={model} value={model}>
                    {model}{installedModelSet.has(model) ? '' : ' (not installed)'}
                  </option>
                ))
              )}
            </select>
            {selectedModel && !installedModelSet.has(selectedModel) && (
              <span className="toolbar-model-note">
                fallback unless pulled
              </span>
            )}
          </label>
          <button type="button" onClick={() => handleExportChat('markdown')} disabled={messages.length === 0}>
            Export MD
          </button>
          <button type="button" onClick={() => handleExportChat('json')} disabled={messages.length === 0}>
            Export JSON
          </button>
        </div>
        <div className="chat-toolbar-system">
          <div className={`toolbar-status-indicator ${connected ? 'connected' : 'disconnected'}`}>
            <span className="toolbar-status-dot"></span>
            <span>{connected ? 'Backend' : 'Backend off'}</span>
          </div>
          <div className={`toolbar-status-indicator ${weaviateReady ? 'connected' : 'disconnected'}`}>
            <span className="toolbar-status-dot"></span>
            <span>{weaviateReady ? 'Weaviate' : 'Weaviate off'}</span>
          </div>
          {chatStatus && <span className="chat-toolbar-status">{chatStatus}</span>}
        </div>
      </div>
      <div className="chat-workspace">
        <aside
          className={`saved-chats-sidebar ${showSavedChatsSidebar ? '' : 'collapsed'}`}
          style={showSavedChatsSidebar ? { '--saved-chats-sidebar-width': `${savedChatsSidebarWidth}px` } : undefined}
        >
          <div className="saved-chats-sidebar-header">
            {showSavedChatsSidebar && <span>Saved chats</span>}
            <button
              type="button"
              className="saved-chats-collapse-button"
              onClick={() => setShowSavedChatsSidebar(current => !current)}
              aria-label={showSavedChatsSidebar ? 'Collapse saved chats sidebar' : 'Expand saved chats sidebar'}
              title={showSavedChatsSidebar ? 'Collapse saved chats' : 'Expand saved chats'}
            >
              ☰
            </button>
          </div>
          {showSavedChatsSidebar && (
            <div className="saved-chats-list">
              {savedChats.length === 0 ? (
                <div className="saved-chats-empty">No saved chats.</div>
              ) : (
                savedChats.map(chat => {
                  const isActiveChat = activeSavedChatId === chat.id;
                  return (
                  <div
                    key={chat.id}
                    className={`saved-chat-row ${isActiveChat ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="saved-chat-item"
                      onClick={() => handleLoadChat(chat.id)}
                      title={chat.title}
                    >
                      {chat.title}
                    </button>
                    {isActiveChat && (
                      <div
                        className="saved-chat-actions-menu"
                        ref={savedChatActionsRef}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) {
                            setShowSavedChatActions(false);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="saved-chat-actions-button"
                          onClick={() => setShowSavedChatActions(current => !current)}
                          aria-label="Saved chat actions"
                          aria-expanded={showSavedChatActions}
                          title="Saved chat actions"
                        >
                          ...
                        </button>
                        {showSavedChatActions && (
                          <div className="saved-chat-actions-popover">
                            <button
                              type="button"
                              onClick={() => {
                                setShowSavedChatActions(false);
                                handleSaveChat();
                              }}
                              disabled={messages.length === 0}
                            >
                              Save current chat
                            </button>
                            <button
                              type="button"
                              onClick={handleNewChat}
                              disabled={messages.length === 0 && !activeSavedChatId}
                            >
                              New chat
                            </button>
                            <button
                              type="button"
                              onClick={handleRenameSavedChat}
                              disabled={!activeSavedChatId}
                            >
                              Rename selected
                            </button>
                            <button
                              type="button"
                              className="saved-chat-delete-action"
                              onClick={handleDeleteSavedChat}
                              disabled={!activeSavedChatId}
                            >
                              Delete selected
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>
          )}
          {showSavedChatsSidebar && (
            <div
              className="saved-chats-sidebar-resize-handle"
              onPointerDown={startSavedChatsSidebarResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize saved chats sidebar"
              title="Resize saved chats sidebar"
            />
          )}
        </aside>
        <div className="chat-main">
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
      </div>
    </div>
  );
}

export default Chat;
