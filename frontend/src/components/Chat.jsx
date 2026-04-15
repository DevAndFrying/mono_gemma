import React, { useState, useEffect, useRef } from 'react';
import './Chat.css';
import Message from './Message';
import InputArea from './InputArea';

function Chat({ connected }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    // Establish WebSocket connection to backend, not frontend
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//localhost:3000`;
    
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
                  content: (lastMsg.content || '') + data.payload.text,
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

  const handleSendMessage = async (text) => {
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

    // Show loading message after 2 seconds if no response yet
    const loadingTimeout = setTimeout(() => {
      setMessages(prev => {
        const updated = [...prev];
        const lastMsg = updated[updated.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.hasStarted) {
          lastMsg.showLoading = true;
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
          payload: { text },
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
        disabled={!connected || loading || !wsConnected}
        loading={loading}
      />
    </div>
  );
}

export default Chat;
