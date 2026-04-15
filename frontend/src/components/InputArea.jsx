import React, { useState } from 'react';
import './InputArea.css';

function InputArea({ onSendMessage, disabled, loading }) {
  const [input, setInput] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSendMessage(input);
      setInput('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form className="input-area" onSubmit={handleSubmit}>
      <div className="input-wrapper">
        <textarea
          className="input-field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled ? 'Connecting to backend...' : 'Type your message... (Shift+Enter for new line)'
          }
          disabled={disabled}
          rows="1"
        />
        <button
          type="submit"
          className="send-button"
          disabled={disabled || !input.trim() || loading}
          title="Send message (Enter)"
        >
          {loading ? '⏳' : '📤'}
        </button>
      </div>
    </form>
  );
}

export default InputArea;
