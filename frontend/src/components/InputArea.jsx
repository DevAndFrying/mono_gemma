import React, { useRef, useState } from 'react';
import './InputArea.css';

function InputArea({ onSendMessage, onUploadFiles, disabled, uploadDisabled, uploadStatus, loading, uploadLoading }) {
  const [input, setInput] = useState('');
  const [collectionName, setCollectionName] = useState('UploadedFile');
  const [useWeaviateContext, setUseWeaviateContext] = useState(true);
  const fileInputRef = useRef(null);
  const repoInputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSendMessage(input, collectionName, useWeaviateContext);
      setInput('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileChange = (e, source = 'files') => {
    const files = Array.from(e.target.files || []);
    if (files.length && !uploadDisabled && !uploadLoading) {
      onUploadFiles(files, collectionName, { source });
    }
    e.target.value = '';
  };

  const uploadHint = uploadStatus?.status === 'ready'
    ? `Uploads enabled: ${uploadStatus.url || 'Weaviate is ready'}`
    : uploadStatus?.error || 'Waiting for Weaviate...';

  return (
    <form className="input-area" onSubmit={handleSubmit}>
      <div className="upload-row">
        <label className="collection-label" htmlFor="weaviate-collection">
          Collection
        </label>
        <input
          id="weaviate-collection"
          className="collection-input"
          value={collectionName}
          onChange={(e) => setCollectionName(e.target.value)}
          disabled={uploadDisabled || uploadLoading}
          spellCheck="false"
        />
        <input
          ref={fileInputRef}
          type="file"
          className="file-input"
          multiple
          onChange={(e) => handleFileChange(e, 'files')}
          disabled={uploadDisabled || uploadLoading}
          accept=".pdf,.txt,.md,.csv,.json,.log,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml"
        />
        <input
          ref={repoInputRef}
          type="file"
          className="file-input"
          multiple
          webkitdirectory=""
          directory=""
          onChange={(e) => handleFileChange(e, 'repo')}
          disabled={uploadDisabled || uploadLoading}
        />
        <button
          type="button"
          className="upload-button"
          disabled={uploadDisabled || uploadLoading}
          onClick={() => fileInputRef.current?.click()}
          title="Upload PDF or text files to Weaviate"
        >
          {uploadLoading ? 'Uploading...' : 'Upload files'}
        </button>
        <button
          type="button"
          className="upload-button"
          disabled={uploadDisabled || uploadLoading}
          onClick={() => repoInputRef.current?.click()}
          title="Upload a folder or repository to Weaviate"
        >
          Upload repo
        </button>
        <span className={`upload-hint ${uploadStatus?.status === 'ready' ? 'ready' : 'offline'}`}>
          {uploadHint}
        </span>
        <label className="context-toggle">
          <input
            type="checkbox"
            checked={useWeaviateContext}
            onChange={(e) => setUseWeaviateContext(e.target.checked)}
          />
          Use Weaviate context
        </label>
      </div>
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
          disabled={disabled || !input.trim() || loading || uploadLoading}
          title="Send message (Enter)"
        >
          {loading ? '⏳' : '📤'}
        </button>
      </div>
    </form>
  );
}

export default InputArea;
