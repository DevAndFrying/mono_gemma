import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import Chat from './components/Chat';
import Header from './components/Header';

function App() {
  const [connected, setConnected] = useState(false);
  const [modelInfo, setModelInfo] = useState(null);
  const [modelOptions, setModelOptions] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [weaviateInfo, setWeaviateInfo] = useState({ status: 'checking' });
  const wsRef = useRef(null);

  useEffect(() => {
    // Check if backend and Weaviate are reachable
    const checkHealth = async () => {
      try {
        const response = await fetch('/api/health');
        if (response.ok) {
          setConnected(true);
          const data = await response.json();
          setModelInfo(data);
        }
      } catch (error) {
        console.error('Backend health check failed:', error);
        setConnected(false);
      }

      try {
        const response = await fetch('/api/weaviate/health');
        const data = await response.json();
        setWeaviateInfo(data);
      } catch (error) {
        console.error('Weaviate health check failed:', error);
        setWeaviateInfo({ status: 'unavailable', error: error.message });
      }

      try {
        const response = await fetch('/api/models');
        const data = await response.json();
        const models = Array.isArray(data.models)
          ? data.models.map(model => (typeof model === 'string' ? model : model.name)).filter(Boolean)
          : [];
        const defaultModel = data.defaultModel || modelInfo?.model || '';
        const uniqueModels = Array.from(new Set([defaultModel, ...models].filter(Boolean)));

        setModelOptions(uniqueModels);
        setSelectedModel(current => current || defaultModel || uniqueModels[0] || '');
      } catch (error) {
        console.error('Model list check failed:', error);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app">
      <Header
        connected={connected}
        modelInfo={modelInfo}
        modelOptions={modelOptions}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        weaviateInfo={weaviateInfo}
      />
      <main className="app-main">
        <Chat connected={connected} selectedModel={selectedModel} weaviateInfo={weaviateInfo} />
      </main>
    </div>
  );
}

export default App;
