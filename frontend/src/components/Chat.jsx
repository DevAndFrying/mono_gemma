import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './Chat.css';
import Message from './Message';
import InputArea from './InputArea';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function Chat({ connected, selectedModel, weaviateInfo }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const hasShownModelLoadingRef = useRef(false);

  const replaceLastUploadStatus = (message) => {
    setMessages(prev => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg?.role === 'assistant' && lastMsg.content?.startsWith('Uploading ')) {
        updated[updated.length - 1] = message;
        return updated;
      }
      return [...updated, message];
    });
  };

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.VITE_WS_URL
      || (
        window.location.port === '5173'
          ? `${protocol}//${window.location.hostname}:3002`
          : `${protocol}//${window.location.host}`
      );
    
    console.log('🔌 Connecting WebSocket to:', wsUrl);
    console.log('   Frontend URL:', window.location.href);
    
    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log('✅ WebSocket connected (state: OPEN)');
        wsRef.current.isConnected = true;
        setWsConnected(true);
      };

      wsRef.current.onmessage = (event) => {
        console.log('📨 WebSocket message received:', event.data.substring(0, 100));
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
                  content: `❌ Error: ${data.payload.error}`,
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
        console.error('❌ WebSocket error:', error);
        console.error('   State after error:', wsRef.current?.readyState);
      };

      wsRef.current.onclose = (event) => {
        console.log('❌ WebSocket closed (state: CLOSED)');
        console.log('   Code:', event.code, 'Reason:', event.reason);
        wsRef.current.isConnected = false;
        setWsConnected(false);
      };
    } catch (error) {
      console.error('❌ Failed to create WebSocket:', error);
    }

    return () => {
      if (wsRef.current) {
        console.log('🧹 Cleaning up WebSocket...');
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (text, className, useWeaviateContext = true) => {
    if (!text.trim() || !connected || !wsConnected) {
      if (!wsConnected) {
        console.warn('⚠️ WebSocket not connected yet. Try again in a moment.');
      }
      return;
    }

    // Add user message and assistant placeholder atomically
    const userMessage = { role: 'user', content: text };
    const assistantPlaceholder = { role: 'assistant', content: '', showLoading: false, hasStarted: false };
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
      console.log('📤 Sending message via WebSocket:', text.substring(0, 50));
      
      // Store timeout so we can clear it when response arrives
      wsRef.current.loadingTimeout = loadingTimeout;
      
      wsRef.current.send(
        JSON.stringify({
          type: 'message',
          payload: { text, className, model: selectedModel, useWeaviateContext },
        })
      );
    } else {
      console.error('❌ WebSocket not connected (wsConnected:', wsConnected, ')');
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

  const extractFileText = async (file) => {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      return extractPdfText(file);
    }
    return file.text();
  };

  const handleUploadFiles = async (files, className) => {
    if (!connected || uploading || weaviateInfo?.status !== 'ready') {
      replaceLastUploadStatus({
        role: 'error',
        content: weaviateInfo?.error || 'Weaviate is not ready for uploads.',
      });
      return;
    }

    setUploading(true);
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Uploading ${files.length} file${files.length === 1 ? '' : 's'} to Weaviate...`,
      },
    ]);

    try {
      const payloadFiles = await Promise.all(files.map(async (file) => ({
        name: file.name,
        type: file.type || 'text/plain',
        size: file.size,
        content: await extractFileText(file),
      })));

      const response = await fetch('/api/weaviate/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          className,
          files: payloadFiles,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Upload failed');
      }

      const uploadedNames = data.uploaded.map(file => file.fileName).join(', ');
      replaceLastUploadStatus({
        role: 'assistant',
        content: `Uploaded ${data.count} file${data.count === 1 ? '' : 's'} to ${data.className}: ${uploadedNames}`,
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
      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">🤖</div>
            <h2>Welcome to MCP Gemma Chat</h2>
            <p>Start a conversation with the Gemma model</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <Message key={idx} role={msg.role} content={msg.content} thinking={msg.thinking} showLoading={msg.showLoading} />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <InputArea
        onSendMessage={handleSendMessage}
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
