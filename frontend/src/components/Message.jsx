import React, { useState } from 'react';
import './Message.css';

const normalizeProseSpacing = (text) => (
  text
    .replace(/([.!?])(?=[A-Z])/g, '$1 ')
    .replace(/([.!?]) {2,}/g, '$1 ')
);

const renderInline = (text) => {
  const normalizedText = normalizeProseSpacing(text);
  const parts = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(normalizedText.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a key={`${match.index}-link`} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        );
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < normalizedText.length) {
    parts.push(normalizedText.slice(lastIndex));
  }

  return parts;
};

const renderFormattedContent = (text) => {
  const blocks = [];
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={blocks.length} className="response-code">
          {language && <span className="response-code-language">{language}</span>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const HeadingTag = `h${Math.min(headingMatch[1].length + 2, 5)}`;
      blocks.push(<HeadingTag key={blocks.length}>{renderInline(headingMatch[2])}</HeadingTag>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={blocks.length}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !lines[index].trim().startsWith('```')
      && !/^(#{1,3})\s+/.test(lines[index])
      && !/^\s*[-*]\s+/.test(lines[index])
      && !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push(<p key={blocks.length}>{renderInline(paragraphLines.join(' '))}</p>);
  }

  return blocks;
};

function Message({ role, content, thinking, showLoading, sources = [] }) {
  const [showThinking, setShowThinking] = useState(false);
  const avatarText = role === 'user' ? 'You' : role === 'error' ? '!' : 'AI';

  return (
    <div className={`message message-${role}`}>
      <div className="message-avatar">
        {avatarText}
      </div>
      <div className="message-content">
        {showLoading && (
          <div className="loading-indicator">
            <p>Loading model... first response can take 1-3 minutes.</p>
          </div>
        )}
        {thinking && (
          <div className="message-thinking">
            <button
              className="thinking-toggle"
              onClick={() => setShowThinking(!showThinking)}
              title={showThinking ? 'Hide thinking' : 'Show thinking'}
            >
              {showThinking ? 'Hide' : 'Show'} thinking ({thinking.length} chars)
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
            {role === 'assistant' ? renderFormattedContent(content) : content}
          </div>
        )}
        {role === 'assistant' && sources.length > 0 && (
          <div className="message-sources">
            <div className="message-sources-title">RAG sources</div>
            <div className="message-source-list">
              {sources.map((source) => {
                const SourceTag = source.sourceUrl ? 'a' : 'div';
                return (
                  <SourceTag
                    key={`${source.index}-${source.id || source.filePath}`}
                    className="message-source"
                    href={source.sourceUrl}
                    target={source.sourceUrl ? '_blank' : undefined}
                    rel={source.sourceUrl ? 'noreferrer' : undefined}
                    title={source.filePath || source.fileName}
                  >
                    <span className="message-source-index">[{source.index}]</span>
                    <span className="message-source-name">{source.filePath || source.fileName || 'Source'}</span>
                    {typeof source.certainty === 'number' && (
                      <span className="message-source-score">{source.certainty.toFixed(2)}</span>
                    )}
                  </SourceTag>
                );
              })}
            </div>
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
