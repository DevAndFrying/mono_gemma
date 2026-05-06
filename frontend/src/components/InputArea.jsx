import React, { useEffect, useRef, useState } from 'react';
import './InputArea.css';

const SUPPORTED_UPLOAD_ACCEPT = [
  '.pdf',
  '.pptx',
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

const TEMPERATURE_BOUNDS = { min: 0, max: 1, maxLength: 4 };
const TOP_P_BOUNDS = { min: 0.05, max: 1, maxLength: 4 };
const CONTEXT_CHARS_BOUNDS = { min: 1000, max: 64000, maxLength: 5 };

const formatFileSize = (size) => {
  if (typeof size !== 'number' || Number.isNaN(size)) {
    return 'Unknown size';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatUploadedAt = (uploadedAt) => {
  if (!uploadedAt) {
    return 'Unknown date';
  }
  const date = new Date(uploadedAt);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const formatSettingNumber = (value) => String(Number(value.toFixed(2)));

const sanitizeDecimalSettingInput = (value, { max, maxLength }) => {
  let nextValue = value.replace(/[^\d.]/g, '');
  const decimalIndex = nextValue.indexOf('.');
  if (decimalIndex !== -1) {
    nextValue = `${nextValue.slice(0, decimalIndex + 1)}${nextValue.slice(decimalIndex + 1).replace(/\./g, '')}`;
  }
  nextValue = nextValue.slice(0, maxLength);

  if (nextValue === '' || nextValue === '.') {
    return nextValue;
  }

  const numberValue = Number(nextValue);
  return Number.isFinite(numberValue) && numberValue > max
    ? formatSettingNumber(max)
    : nextValue;
};

const normalizeDecimalSettingInput = (value, bounds) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return formatSettingNumber(bounds.min);
  }
  return formatSettingNumber(clampNumber(numberValue, bounds.min, bounds.max));
};

const sanitizeIntegerSettingInput = (value, { max, maxLength }) => {
  const nextValue = value.replace(/\D/g, '').slice(0, maxLength);
  if (!nextValue) {
    return nextValue;
  }

  const numberValue = Number(nextValue);
  return Number.isFinite(numberValue) && numberValue > max ? String(max) : nextValue;
};

const normalizeIntegerSettingInput = (value, bounds) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return String(bounds.min);
  }
  return String(Math.trunc(clampNumber(numberValue, bounds.min, bounds.max)));
};

const readJsonResponse = async (response) => {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(response.ok ? 'Server returned an invalid JSON response.' : text);
  }
};

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
  const [showContextSettings, setShowContextSettings] = useState(true);
  const [temperature, setTemperature] = useState('0.2');
  const [topP, setTopP] = useState('0.85');
  const [contextChars, setContextChars] = useState('16000');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showLibraryManager, setShowLibraryManager] = useState(false);
  const [selectedDeleteCollection, setSelectedDeleteCollection] = useState('');
  const [selectedManageCollection, setSelectedManageCollection] = useState(selectedUploadCollection || 'uploaded_files');
  const [createCollectionStatus, setCreateCollectionStatus] = useState(null);
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [libraryFilesLoading, setLibraryFilesLoading] = useState(false);
  const [libraryFilesError, setLibraryFilesError] = useState('');
  const [deletingFileId, setDeletingFileId] = useState('');
  const fileInputRef = useRef(null);
  const repoInputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      const normalizedTemperature = normalizeDecimalSettingInput(temperature, TEMPERATURE_BOUNDS);
      const normalizedTopP = normalizeDecimalSettingInput(topP, TOP_P_BOUNDS);
      const normalizedContextChars = normalizeIntegerSettingInput(contextChars, CONTEXT_CHARS_BOUNDS);

      setTemperature(normalizedTemperature);
      setTopP(normalizedTopP);
      setContextChars(normalizedContextChars);

      onSendMessage(input, selectedContextCollections, useWeaviateContext, {
        temperature: Number(normalizedTemperature),
        top_p: Number(normalizedTopP),
        contextChars: Number(normalizedContextChars),
      });
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
    const collectionName = newCollectionName.trim();
    setCreateCollectionStatus(null);
    const result = await onCreateCollection(newCollectionName);
    if (result?.ok) {
      setNewCollectionName('');
      setSelectedManageCollection(result.collection?.name || collectionName);
      setCreateCollectionStatus({ type: 'success', message: result.message || `Created ${result.collection?.name || collectionName}.` });
      return;
    }

    setCreateCollectionStatus({ type: 'error', message: result?.message || 'Failed to create Weaviate library.' });
  };

  const handleDeleteCollection = () => {
    onDeleteCollection(selectedDeleteCollection || manageCollectionName);
  };

  const loadLibraryFiles = async (collectionName = selectedManageCollection) => {
    if (!collectionName || uploadStatus?.status !== 'ready') {
      setLibraryFiles([]);
      return;
    }

    setLibraryFilesLoading(true);
    setLibraryFilesError('');
    try {
      const response = await fetch(`/api/weaviate/collections/${encodeURIComponent(collectionName)}/files`);
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load library files');
      }
      setLibraryFiles(data.files || []);
    } catch (error) {
      setLibraryFiles([]);
      setLibraryFilesError(error.message);
    } finally {
      setLibraryFilesLoading(false);
    }
  };

  const handleFileChange = async (event, source = 'files') => {
    const files = Array.from(event.target.files || []);
    if (files.length && !uploadDisabled && !uploadLoading) {
      await onUploadFiles(files, selectedManageCollection || selectedUploadCollection, { source });
      await loadLibraryFiles(selectedManageCollection || selectedUploadCollection);
    }
    event.target.value = '';
  };

  const handleDeleteFile = async (file) => {
    if (!selectedManageCollection || !file?.id) {
      return;
    }
    const confirmed = window.confirm(`Delete "${file.filePath || file.fileName}" from ${selectedManageCollection}?`);
    if (!confirmed) {
      return;
    }

    setDeletingFileId(file.id);
    setLibraryFilesError('');
    try {
      const response = await fetch(
        `/api/weaviate/collections/${encodeURIComponent(selectedManageCollection)}/files/${encodeURIComponent(file.id)}`,
        { method: 'DELETE' }
      );
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete file');
      }
      setLibraryFiles(currentFiles => currentFiles.filter(currentFile => currentFile.id !== file.id));
    } catch (error) {
      setLibraryFilesError(error.message);
    } finally {
      setDeletingFileId('');
    }
  };

  const handleContextCollectionToggle = (collectionName, checked) => {
    const nextCollections = checked
      ? Array.from(new Set([...selectedContextCollections, collectionName]))
      : selectedContextCollections.filter(name => name !== collectionName);
    onContextCollectionsChange(nextCollections);
  };

  const handleTemperatureChange = (event) => {
    setTemperature(sanitizeDecimalSettingInput(event.target.value, TEMPERATURE_BOUNDS));
  };

  const handleTopPChange = (event) => {
    setTopP(sanitizeDecimalSettingInput(event.target.value, TOP_P_BOUNDS));
  };

  const handleContextCharsChange = (event) => {
    setContextChars(sanitizeIntegerSettingInput(event.target.value, CONTEXT_CHARS_BOUNDS));
  };

  const collectionOptions = Array.from(
    new Map(
      [
        ...collections,
        ...(collections.length === 0 || collections.some(collection => collection.name === selectedUploadCollection)
          ? [{ name: selectedUploadCollection || 'uploaded_files' }]
          : []),
      ]
        .filter(collection => collection?.name)
        .map(collection => [collection.name, collection])
    ).values()
  ).sort((left, right) => left.name.localeCompare(right.name));
  const deleteCollectionName = selectedDeleteCollection || collectionOptions[0]?.name || '';
  const manageCollectionName = selectedManageCollection || collectionOptions[0]?.name || '';

  useEffect(() => {
    if (selectedDeleteCollection && !collectionOptions.some(collection => collection.name === selectedDeleteCollection)) {
      setSelectedDeleteCollection('');
    }
  }, [collectionOptions, selectedDeleteCollection]);

  useEffect(() => {
    if (!manageCollectionName || collectionOptions.some(collection => collection.name === selectedManageCollection)) {
      return;
    }
    setSelectedManageCollection(manageCollectionName);
  }, [collectionOptions, manageCollectionName, selectedManageCollection]);

  useEffect(() => {
    if (showLibraryManager) {
      loadLibraryFiles(manageCollectionName);
    }
  }, [showLibraryManager, manageCollectionName, uploadStatus?.status]);
  const contextSummary = selectedContextCollections.length
    ? `${selectedContextCollections.length} expert${selectedContextCollections.length === 1 ? '' : 's'} selected`
    : 'No experts selected';
  const uploadHint = uploadStatus?.status === 'ready'
    ? `Adding to ${manageCollectionName}`
    : uploadStatus?.error || 'Waiting for Weaviate...';

  return (
    <form className="input-area" onSubmit={handleSubmit}>
      <div className={`context-library ${showContextSettings ? '' : 'collapsed'}`}>
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
              onClick={() => setShowContextSettings(current => !current)}
              aria-expanded={showContextSettings}
              title="Show or hide expert and model settings"
            >
              {showContextSettings ? 'Collapse' : 'Expand'}
            </button>
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
        {showContextSettings && (
          <>
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
            <div className="model-settings">
              <label className="model-setting">
                <span>Temperature</span>
                <input
                  type="text"
                  inputMode="decimal"
                  maxLength={TEMPERATURE_BOUNDS.maxLength}
                  value={temperature}
                  onChange={handleTemperatureChange}
                  onBlur={() => setTemperature(normalizeDecimalSettingInput(temperature, TEMPERATURE_BOUNDS))}
                  disabled={disabled || loading || uploadLoading}
                />
              </label>
              <label className="model-setting">
                <span>Top P</span>
                <input
                  type="text"
                  inputMode="decimal"
                  maxLength={TOP_P_BOUNDS.maxLength}
                  value={topP}
                  onChange={handleTopPChange}
                  onBlur={() => setTopP(normalizeDecimalSettingInput(topP, TOP_P_BOUNDS))}
                  disabled={disabled || loading || uploadLoading}
                />
              </label>
              <label className="model-setting">
                <span>Context chars</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={CONTEXT_CHARS_BOUNDS.maxLength}
                  value={contextChars}
                  onChange={handleContextCharsChange}
                  onBlur={() => setContextChars(normalizeIntegerSettingInput(contextChars, CONTEXT_CHARS_BOUNDS))}
                  disabled={disabled || loading || uploadLoading || !useWeaviateContext}
                />
              </label>
            </div>
          </>
        )}
      </div>
      {showLibraryManager && (
        <div className="library-modal-backdrop" role="presentation">
          <div className="library-manager" role="dialog" aria-modal="true" aria-labelledby="library-manager-title">
            <div className="library-manager-header">
              <div>
                <h2 id="library-manager-title">Manage expert libraries</h2>
                <span>{libraryFiles.length} file{libraryFiles.length === 1 ? '' : 's'} in selected library</span>
              </div>
              <button
                type="button"
                className="library-manager-close"
                onClick={() => setShowLibraryManager(false)}
                aria-label="Close expert library manager"
                title="Close expert library manager"
              >
                X
              </button>
            </div>
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
            <div className="library-manager-toolbar">
              <label className="library-field" htmlFor="manage-collection-select">
                <span>Expert library</span>
                <select
                  id="manage-collection-select"
                  value={manageCollectionName}
                  onChange={(event) => {
                    setSelectedManageCollection(event.target.value);
                    onUploadCollectionChange(event.target.value);
                  }}
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
                    disabled={uploadDisabled || uploadLoading || !manageCollectionName}
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload PDF, PowerPoint, text, or code files to Weaviate"
                  >
                    {uploadLoading ? 'Uploading...' : 'Add files'}
                  </button>
                  <button
                    type="button"
                    className="upload-button"
                    disabled={uploadDisabled || uploadLoading || !manageCollectionName}
                    onClick={() => repoInputRef.current?.click()}
                    title="Upload a folder or repository to Weaviate"
                  >
                    Add repo
                  </button>
                  <button
                    type="button"
                    className="upload-button"
                    disabled={uploadDisabled || libraryFilesLoading || !manageCollectionName}
                    onClick={() => loadLibraryFiles(manageCollectionName)}
                    title="Refresh file list"
                  >
                    Refresh
                  </button>
                </div>
              </div>
            </div>
            <div className="library-files">
              <div className="library-files-header">
                <span>Files</span>
                {libraryFilesError && <span className="library-files-error">{libraryFilesError}</span>}
              </div>
              {libraryFilesLoading ? (
                <div className="library-files-empty">Loading files...</div>
              ) : libraryFiles.length === 0 ? (
                <div className="library-files-empty">No files in this library.</div>
              ) : (
                <div className="library-files-list">
                  {libraryFiles.map(file => (
                    <div key={file.id} className="library-file-row">
                      <div className="library-file-main">
                        <span className="library-file-name">{file.filePath || file.fileName}</span>
                        <span className="library-file-meta">
                          {formatFileSize(file.size)} | {formatUploadedAt(file.uploadedAt)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="delete-file-button"
                        disabled={deletingFileId === file.id}
                        onClick={() => handleDeleteFile(file)}
                        title="Delete this file from the selected library"
                      >
                        {deletingFileId === file.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="library-manager-footer">
              <div className="library-create">
                <label className="library-field" htmlFor="new-collection-name">
                  <span>New expert library</span>
                  <input
                    id="new-collection-name"
                    type="text"
                    value={newCollectionName}
                    onChange={(event) => {
                      setNewCollectionName(event.target.value);
                      setCreateCollectionStatus(null);
                    }}
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
                {createCollectionStatus && (
                  <span className={`library-create-status ${createCollectionStatus.type}`} role="status">
                    {createCollectionStatus.message}
                  </span>
                )}
              </div>
              <div className="library-delete">
                <label className="library-field" htmlFor="delete-collection-select">
                  <span>Delete expert library</span>
                  <select
                    id="delete-collection-select"
                    value={deleteCollectionName}
                    onChange={(event) => setSelectedDeleteCollection(event.target.value)}
                    disabled={uploadDisabled || uploadLoading || collectionLoading}
                  >
                    {collectionOptions.map(collection => (
                      <option key={collection.name} value={collection.name}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="delete-library-button"
                  disabled={uploadDisabled || uploadLoading || collectionLoading || !deleteCollectionName}
                  onClick={handleDeleteCollection}
                  title="Delete the selected Weaviate expert library"
                >
                  Delete library
                </button>
              </div>
            </div>
          </div>
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
