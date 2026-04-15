import React from 'react';
import './Header.css';

function Header({ connected, modelInfo }) {
  return (
    <header className="header">
      <div className="header-content">
        <div className="header-title">
          <h1>🤖 MCP Gemma Chat</h1>
          <p className="model-name">
            {modelInfo?.model || 'Loading...'}
          </p>
        </div>
        <div className="header-status">
          <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            <span>{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;
