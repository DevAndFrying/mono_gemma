import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import Chat from './components/Chat';
import Header from './components/Header';

function App() {
  const [connected, setConnected] = useState(false);
  const [modelInfo, setModelInfo] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    // Check if backend is running
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
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app">
      <Header connected={connected} modelInfo={modelInfo} />
      <main className="app-main">
        <Chat connected={connected} />
      </main>
    </div>
  );
}

export default App;
