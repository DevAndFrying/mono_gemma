import React, { useState } from 'react';
import './Message.css';

function Message({ role, content, thinking, showLoading }) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className={`message message-${role}`}>
      <div className="message-avatar">
        {role === 'user' ? '👤' : role === 'error' ? '⚠️' : '🤖'}
      </div>
      <div className="message-content">
        {showLoading && (
          <div className="loading-indicator">
            <p>⏳ Loading model... (first response takes 1-3 minutes)</p>
          </div>
        )}
        {thinking && (
          <div className="message-thinking">
            <button
              className="thinking-toggle"
              onClick={() => setShowThinking(!showThinking)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
            >
              {showThinking ? '▼' : '▶'} 💭 Thinking ({thinking.length} chars)
            </button>
            {showThinking && (
              <div className="thinking-content">
                <p>{thinking}</p>
              </div>
            )}
          </div>
        )}
        {content && (
          <div className={`response-text ${role === 'error' ? 'error-message' : ''}`}>
            {content}
          </div>
        )}
        {!content && !showLoading && role === 'assistant' && (
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>
    </div>
  );
}

export default Message;
