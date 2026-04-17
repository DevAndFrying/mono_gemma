import React from 'react';
import './Header.css';

function Header({ connected, modelInfo, modelOptions, selectedModel, onModelChange, installedModels, weaviateInfo }) {
  const weaviateReady = weaviateInfo?.status === 'ready';
  const installedModelSet = new Set(installedModels || []);

  return (
    <header className="header">
      <div className="header-content">
        <div className="header-title">
          <h1>🤖 MCP Gemma Chat</h1>
          <p className="model-name">
            Default: {modelInfo?.model || 'Loading...'}
          </p>
        </div>
        <label className="model-picker" htmlFor="model-select">
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
            <span className="model-picker-note">
              Will use fallback unless pulled
            </span>
          )}
        </label>
        <div className="header-status">
          <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            <span>{connected ? 'Backend' : 'Backend off'}</span>
          </div>
          <div className={`status-indicator ${weaviateReady ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            <span>{weaviateReady ? 'Weaviate' : 'Weaviate off'}</span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;
