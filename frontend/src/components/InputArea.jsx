import React, { useRef, useState } from 'react';
import './InputArea.css';

const SUPPORTED_UPLOAD_ACCEPT = [
  '.pdf',
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
].join(',');

function InputArea({
  onSendMessage,
  onStopChat,
  onUploadFiles,
  onCreateCollection,
  onDeleteCollection,
  disabled,
  uploadDisabled,
  uploadStatus,
  loading,
  uploadLoading,
  collections,
  selectedUploadCollection,
  onUploadCollectionChange,
  selectedContextCollections,
  onContextCollectionsChange,
  collectionLoading,
}) {
  const [input, setInput] = useState('');
  const [useWeaviateContext, setUseWeaviateContext] = useState(true);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showLibraryManager, setShowLibraryManager] = useState(false);
  const fileInputRef = useRef(null);
  const repoInputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSendMessage(input, selectedContextCollections, useWeaviateContext);
      setInput('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleCreateCollection = async () => {
    const created = await onCreateCollection(newCollectionName);
    if (created) {
      setNewCollectionName('');
    }
  };

  const handleDeleteCollection = () => {
    onDeleteCollection(selectedUploadCollection);
  };

  const handleFileChange = (event, source = 'files') => {
    const files = Array.from(event.target.files || []);
    if (files.length && !uploadDisabled && !uploadLoading) {
      onUploadFiles(files, selectedUploadCollection, { source });
    }
    event.target.value = '';
  };

  const handleContextCollectionToggle = (collectionName, checked) => {
    const nextCollections = checked
      ? Array.from(new Set([...selectedContextCollections, collectionName]))
      : selectedContextCollections.filter(name => name !== collectionName);
    onContextCollectionsChange(nextCollections);
  };

  const collectionOptions = Array.from(
    new Map(
      [
        ...collections,
        ...selectedContextCollections.map(name => ({ name })),
        { name: selectedUploadCollection || 'uploaded_files' },
      ]
        .filter(collection => collection?.name)
        .map(collection => [collection.name, collection])
    ).values()
  ).sort((left, right) => left.name.localeCompare(right.name));
  const contextSummary = selectedContextCollections.length
    ? `${selectedContextCollections.length} expert${selectedContextCollections.length === 1 ? '' : 's'} selected`
    : 'No experts selected';
  const uploadHint = uploadStatus?.status === 'ready'
    ? `Adding to ${selectedUploadCollection}`
    : uploadStatus?.error || 'Waiting for Weaviate...';

  return (
    <form className="input-area" onSubmit={handleSubmit}>
      <div className="context-library">
        <div className="context-library-header">
          <label className="context-toggle">
            <input
              type="checkbox"
              checked={useWeaviateContext}
              onChange={(e) => setUseWeaviateContext(e.target.checked)}
            />
            Use expert libraries
          </label>
          <div className="context-library-actions">
            <span className="context-summary">{contextSummary}</span>
            <button
              type="button"
              className="library-settings-button"
              onClick={() => setShowLibraryManager(current => !current)}
              aria-expanded={showLibraryManager}
              title="Manage expert libraries"
            >
              Manage
            </button>
          </div>
        </div>
        <div className="context-library-list">
          {collectionOptions.map(collection => (
            <label key={collection.name} className="context-library-option">
              <input
                type="checkbox"
                checked={selectedContextCollections.includes(collection.name)}
                onChange={(event) => handleContextCollectionToggle(collection.name, event.target.checked)}
                disabled={!useWeaviateContext || collectionLoading}
              />
              <span>{collection.name}</span>
            </label>
          ))}
        </div>
      </div>
      {showLibraryManager && (
        <div className="library-manager">
          <input
            ref={fileInputRef}
            type="file"
            className="file-input"
            multiple
            onChange={(event) => handleFileChange(event, 'files')}
            disabled={uploadDisabled || uploadLoading}
            accept={SUPPORTED_UPLOAD_ACCEPT}
          />
          <input
            ref={repoInputRef}
            type="file"
            className="file-input"
            multiple
            webkitdirectory=""
            directory=""
            onChange={(event) => handleFileChange(event, 'repo')}
            disabled={uploadDisabled || uploadLoading}
          />
          <label className="library-field" htmlFor="upload-collection-select">
            <span>Add uploaded files to</span>
            <select
              id="upload-collection-select"
              value={selectedUploadCollection}
              onChange={(event) => onUploadCollectionChange(event.target.value)}
              disabled={uploadDisabled || uploadLoading || collectionLoading}
            >
              {collectionOptions.map(collection => (
                <option key={collection.name} value={collection.name}>
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
          <div className="library-upload-actions">
            <span className={`upload-hint ${uploadStatus?.status === 'ready' ? 'ready' : 'offline'}`}>
              {uploadHint}
            </span>
            <div className="library-upload-buttons">
              <button
                type="button"
                className="upload-button"
                disabled={uploadDisabled || uploadLoading}
                onClick={() => fileInputRef.current?.click()}
                title="Upload PDF, text, or code files to Weaviate"
              >
                {uploadLoading ? 'Uploading...' : 'Upload files to Weaviate'}
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
            </div>
          </div>
          <div className="library-create">
            <label className="library-field" htmlFor="new-collection-name">
              <span>New expert library</span>
              <input
                id="new-collection-name"
                type="text"
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
                placeholder="NewExpertLibrary"
                disabled={uploadDisabled || uploadLoading || collectionLoading}
              />
            </label>
            <button
              type="button"
              className="upload-button"
              disabled={uploadDisabled || uploadLoading || collectionLoading || !newCollectionName.trim()}
              onClick={handleCreateCollection}
              title="Create a new Weaviate expert library"
            >
              Create library
            </button>
          </div>
          <button
            type="button"
            className="delete-library-button"
            disabled={uploadDisabled || uploadLoading || collectionLoading || !selectedUploadCollection}
            onClick={handleDeleteCollection}
            title="Delete the selected Weaviate expert library"
          >
            Delete library
          </button>
        </div>
      )}
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
          Send
        </button>
        {loading && (
          <button
            type="button"
            className="stop-button"
            onClick={onStopChat}
            disabled={uploadLoading}
            title="Stop current response"
          >
            Stop
          </button>
        )}
      </div>
    </form>
  );
}

export default InputArea;
