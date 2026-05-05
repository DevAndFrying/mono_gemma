import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import weaviate from 'weaviate-ts-client';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false,
  verifyClient: (info: any, cb: any) => {
    console.log('🔗 WebSocket connection request from:', info.origin || 'unknown origin');
    cb(true); // Accept all connections
  }
});

// Configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.MODEL_NAME || 'gemma3:4b';
const API_PORT = process.env.API_PORT || 3000;
const MCP_PORT = process.env.MCP_PORT || 3001;
const WEAVIATE_URL = process.env.WEAVIATE_URL || 'http://localhost:8080';
const DEFAULT_WEAVIATE_FILE_CLASS = process.env.WEAVIATE_FILE_CLASS || 'uploaded_files';
const MAX_UPLOAD_FILE_BYTES = Number(process.env.MAX_UPLOAD_FILE_BYTES || 20 * 1024 * 1024);
const WEAVIATE_CONTEXT_RESULTS = Number(process.env.WEAVIATE_CONTEXT_RESULTS || 8);
const WEAVIATE_CONTEXT_CHARS = Number(process.env.WEAVIATE_CONTEXT_CHARS || 16000);
const WEAVIATE_ENABLE_PQ = process.env.WEAVIATE_ENABLE_PQ === 'true';
const WEAVIATE_PQ_TRAINING_LIMIT = Number(process.env.WEAVIATE_PQ_TRAINING_LIMIT || 50000);
const WEAVIATE_UPLOAD_CHUNK_CHARS = Number(process.env.WEAVIATE_UPLOAD_CHUNK_CHARS || 1500);
const WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS = Number(process.env.WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS || 250);
const WEAVIATE_HYBRID_ALPHA = Number(process.env.WEAVIATE_HYBRID_ALPHA || 0.35);
const WEAVIATE_RERANK_CANDIDATE_MULTIPLIER = Number(process.env.WEAVIATE_RERANK_CANDIDATE_MULTIPLIER || 5);
const OLLAMA_MODEL_CACHE_MS = Number(process.env.OLLAMA_MODEL_CACHE_MS || 30000);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m';
const SUGGESTED_MODELS = (process.env.SUGGESTED_MODELS || 'gemma3:4b,gemma3:12b,gemma3:27b')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const weaviateUrl = new URL(WEAVIATE_URL);

// Initialize Weaviate client
const weaviateClient = weaviate.client({
  scheme: weaviateUrl.protocol.replace(':', ''),
  host: weaviateUrl.host,
});

// Middleware
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));

type UploadedFilePayload = {
  name: string;
  path?: string;
  type?: string;
  size?: number;
  content: string;
};

type WeaviateContextItem = {
  id?: string;
  className: string;
  content: string;
  fileName?: string;
  filePath?: string;
  certainty?: number;
  score?: number;
  scoreLabel?: string;
  rerankScore?: number;
  chunkIndex?: number;
  chunkCount?: number;
  sourceUrl?: string;
};

type OllamaModel = {
  name: string;
};

let ollamaModelCache: { models: string[]; expiresAt: number } | null = null;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorStack = (error: unknown) => error instanceof Error ? error.stack : undefined;
const isConnectionRefused = (error: unknown) => errorMessage(error).includes('ECONNREFUSED');
const axiosResponseDetail = (data: unknown, fallback: string) => {
  if (!data) {
    return fallback;
  }
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (typeof data === 'object') {
    const maybeError = (data as { error?: unknown }).error;
    const maybeMessage = (data as { message?: unknown }).message;
    if (typeof maybeError === 'string') {
      return maybeError;
    }
    if (typeof maybeMessage === 'string') {
      return maybeMessage;
    }
    try {
      return JSON.stringify(data);
    } catch {
      return `[unserializable ${data.constructor?.name || 'object'} response]`;
    }
  }
  return String(data);
};
const ollamaErrorMessage = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = axiosResponseDetail(error.response?.data, error.message);

    if (status === 404) {
      return `Ollama model "${MODEL_NAME}" was not found. Pull it with: ollama pull ${MODEL_NAME}. Details: ${detail}`;
    }

    if (status) {
      return `Ollama request failed with status ${status}: ${detail}`;
    }
  }

  return errorMessage(error);
};

const getInstalledOllamaModels = async (): Promise<string[]> => {
  if (ollamaModelCache && ollamaModelCache.expiresAt > Date.now()) {
    return ollamaModelCache.models;
  }

  const response = await axios.get(`${OLLAMA_BASE_URL}/api/tags`);
  const models = (response.data?.models || [])
    .map((model: OllamaModel) => model.name)
    .filter((name: unknown): name is string => typeof name === 'string' && !!name);

  ollamaModelCache = {
    models,
    expiresAt: Date.now() + OLLAMA_MODEL_CACHE_MS,
  };

  return models;
};

const resolveOllamaModel = async (requestedModel?: string) => {
  const requested = requestedModel?.trim();
  const installedModels = await getInstalledOllamaModels();

  if (requested && installedModels.includes(requested)) {
    return {
      model: requested,
      fallback: false,
      requestedModel: requested,
      installedModels,
    };
  }

  if (installedModels.includes(MODEL_NAME)) {
    return {
      model: MODEL_NAME,
      fallback: !!requested && requested !== MODEL_NAME,
      requestedModel: requested,
      installedModels,
    };
  }

  if (installedModels.length > 0) {
    return {
      model: installedModels[0],
      fallback: true,
      requestedModel: requested || MODEL_NAME,
      installedModels,
    };
  }

  return {
    model: requested || MODEL_NAME,
    fallback: !!requested && requested !== MODEL_NAME,
    requestedModel: requested,
    installedModels,
  };
};

const weaviateUnavailableMessage = () => (
  `Weaviate is not reachable at ${WEAVIATE_URL}. Start Weaviate or set WEAVIATE_URL to a running Weaviate instance.`
);

const weaviateVectorIndexConfig = () => ({
  distance: 'cosine',
  ...(WEAVIATE_ENABLE_PQ
    ? {
        pq: {
          enabled: true,
          trainingLimit: WEAVIATE_PQ_TRAINING_LIMIT,
        },
      }
    : {}),
});

const fileCollectionProperties = () => [
  {
    name: 'content',
    dataType: ['text'],
    description: 'Text content extracted from the uploaded file',
  },
  {
    name: 'fileName',
    dataType: ['text'],
    description: 'Original uploaded file name',
  },
  {
    name: 'filePath',
    dataType: ['text'],
    description: 'Relative file path for folder or repository uploads',
  },
  {
    name: 'fileId',
    dataType: ['text'],
    description: 'Stable identifier shared by all chunks from the same uploaded file',
  },
  {
    name: 'chunkIndex',
    dataType: ['int'],
    description: 'Zero-based index of this chunk within the uploaded file',
  },
  {
    name: 'chunkCount',
    dataType: ['int'],
    description: 'Total number of chunks produced from the uploaded file',
  },
  {
    name: 'mimeType',
    dataType: ['text'],
    description: 'Uploaded file MIME type',
  },
  {
    name: 'size',
    dataType: ['int'],
    description: 'Uploaded file size in bytes',
  },
  {
    name: 'uploadedAt',
    dataType: ['date'],
    description: 'Upload timestamp',
  },
];

const ensureFileCollectionProperties = async (className: string) => {
  const schema = await weaviateClient.schema.classGetter().withClassName(className).do();
  const existingProperties = new Set((schema.properties || []).map((property: any) => property.name));

  for (const property of fileCollectionProperties()) {
    if (!existingProperties.has(property.name)) {
      await weaviateClient.schema.propertyCreator()
        .withClassName(className)
        .withProperty(property)
        .do();
    }
  }
};

const normalizeWeaviateClassName = (className?: string) => {
  const trimmed = (className || DEFAULT_WEAVIATE_FILE_CLASS).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error('Collection name must start with a letter and contain only letters, numbers, or underscores.');
  }
  return trimmed;
};

const normalizeWeaviateClassNames = (classNames?: unknown, fallbackClassName?: string) => {
  const hasExplicitList = Array.isArray(classNames);
  const names = Array.isArray(classNames)
    ? classNames
    : (typeof fallbackClassName === 'string' && fallbackClassName.trim() ? [fallbackClassName] : []);

  const normalized = names
    .filter((name): name is string => typeof name === 'string' && !!name.trim())
    .map((name) => normalizeWeaviateClassName(name));

  if (normalized.length > 0) {
    return Array.from(new Set(normalized));
  }

  return hasExplicitList ? [] : [normalizeWeaviateClassName()];
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const normalizeGenerationOptions = (options: { temperature?: unknown; top_p?: unknown } = {}) => ({
  temperature: clampNumber(options.temperature, 0.2, 0, 1),
  top_p: clampNumber(options.top_p, 0.85, 0.05, 1),
});

const normalizeContextOptions = (options: { contextChars?: unknown; contextResults?: unknown } = {}) => ({
  contextChars: Math.round(clampNumber(options.contextChars, WEAVIATE_CONTEXT_CHARS, 1000, 64000)),
  contextResults: Math.round(clampNumber(options.contextResults, WEAVIATE_CONTEXT_RESULTS, 1, 30)),
});

const ensureFileCollection = async (className: string) => {
  const exists = await weaviateClient.schema.exists(className);
  if (exists) {
    await ensureFileCollectionProperties(className);
    return;
  }

  await weaviateClient.schema.classCreator().withClass({
    class: className,
    description: 'Files uploaded from the frontend',
    vectorizer: 'text2vec-transformers',
    vectorIndexType: 'hnsw',
    vectorIndexConfig: weaviateVectorIndexConfig(),
    properties: fileCollectionProperties(),
  }).do();
};

const validateUploadedFiles = (files: UploadedFilePayload[]) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('At least one file is required.');
  }

  return files.map((file) => {
    if (!file || typeof file.name !== 'string' || !file.name.trim()) {
      throw new Error('Each file must include a name.');
    }
    if (typeof file.content !== 'string' || !file.content.trim()) {
      throw new Error(`File "${file.name}" has no readable text content.`);
    }
    if (typeof file.size === 'number' && file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`File "${file.name}" is larger than the ${MAX_UPLOAD_FILE_BYTES} byte limit.`);
    }

    return {
      name: file.name.trim(),
      path: typeof file.path === 'string' && file.path.trim() ? file.path.trim() : file.name.trim(),
      type: file.type || 'text/plain',
      size: typeof file.size === 'number' ? file.size : Buffer.byteLength(file.content, 'utf8'),
      content: file.content,
    };
  });
};

const findExistingFileByPath = async (className: string, filePath: string) => {
  const result = await weaviateClient.graphql
    .get()
    .withClassName(className)
    .withFields('fileName filePath _additional { id }')
    .withWhere({
      path: ['filePath'],
      operator: 'Equal',
      valueText: filePath,
    })
    .withLimit(1)
    .do();

  return result?.data?.Get?.[className]?.[0] || null;
};

const createFileId = (filePath: string) => Buffer.from(filePath).toString('base64url').slice(0, 96);

const splitContentIntoChunks = (content: string) => {
  const normalizedChunkChars = Math.max(1000, WEAVIATE_UPLOAD_CHUNK_CHARS);
  const normalizedOverlapChars = Math.min(
    Math.max(0, WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS),
    Math.floor(normalizedChunkChars / 2),
  );

  if (content.length <= normalizedChunkChars) {
    return [content.trim()];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const hardEnd = Math.min(content.length, start + normalizedChunkChars);
    let end = hardEnd;
    if (hardEnd < content.length) {
      const breakWindowStart = Math.max(start + Math.floor(normalizedChunkChars * 0.6), hardEnd - 600);
      const breakWindow = content.slice(breakWindowStart, hardEnd);
      const paragraphBreak = breakWindow.lastIndexOf('\n\n');
      const lineBreak = breakWindow.lastIndexOf('\n');
      const sentenceBreak = Math.max(
        breakWindow.lastIndexOf('. '),
        breakWindow.lastIndexOf('? '),
        breakWindow.lastIndexOf('! '),
      );
      const bestBreak = Math.max(paragraphBreak, lineBreak, sentenceBreak);
      if (bestBreak > 0) {
        end = breakWindowStart + bestBreak + 1;
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= content.length) {
      break;
    }
    start = Math.max(end - normalizedOverlapChars, start + 1);
  }

  return chunks;
};

const truncateText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
};

const extractSearchTerms = (query: string) => {
  const quotedTerms = Array.from(query.matchAll(/"([^"]{3,})"/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
  const words = query
    .toLowerCase()
    .match(/[a-z0-9_./-]{4,}/g) || [];
  return Array.from(new Set([...quotedTerms, ...words])).slice(0, 20);
};

const extractSearchPhrases = (query: string) => {
  const quotedTerms = Array.from(query.matchAll(/"([^"]{3,})"/g))
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean);
  const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalizedQuery.length >= 8) {
    quotedTerms.push(normalizedQuery);
  }
  return Array.from(new Set(quotedTerms)).slice(0, 8);
};

const extractRelevantSnippet = (content: string, query: string, maxLength: number) => {
  if (content.length <= maxLength) {
    return content.trim();
  }

  const normalizedContent = content.toLowerCase();
  const terms = extractSearchTerms(query);
  let bestIndex = -1;
  let bestTermLength = 0;

  for (const term of terms) {
    const index = normalizedContent.indexOf(term.toLowerCase());
    if (index !== -1 && (bestIndex === -1 || term.length > bestTermLength)) {
      bestIndex = index;
      bestTermLength = term.length;
    }
  }

  if (bestIndex === -1) {
    return truncateText(content.trim(), maxLength);
  }

  const contextBefore = Math.max(0, Math.floor((maxLength - bestTermLength) / 2));
  const start = Math.max(0, bestIndex - contextBefore);
  const end = Math.min(content.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
};

const normalizeWeaviateMatches = (
  matches: any[],
  className: string,
  query: string,
  scoreLabel: string,
  snippetLength: number,
): WeaviateContextItem[] => matches
  .filter((item: any) => typeof item.content === 'string' && item.content.trim())
  .map((item: any) => {
    const score = typeof item._additional?.score === 'string'
      ? Number(item._additional.score)
      : item._additional?.score;
    return {
      id: item._additional?.id,
      className,
      content: extractRelevantSnippet(item.content.trim(), query, snippetLength),
      fileName: item.filePath || item.fileName,
      filePath: item.filePath,
      certainty: item._additional?.certainty,
      score: typeof score === 'number' && Number.isFinite(score) ? score : undefined,
      scoreLabel,
      chunkIndex: item.chunkIndex,
      chunkCount: item.chunkCount,
      sourceUrl: item._additional?.id
        ? `/api/weaviate/source/${encodeURIComponent(className)}/${encodeURIComponent(item._additional.id)}`
        : undefined,
    };
  });

const mergeWeaviateResults = (...resultSets: WeaviateContextItem[][]) => {
  const byId = new Map<string, WeaviateContextItem>();
  for (const resultSet of resultSets) {
    for (const item of resultSet) {
      const key = item.id || `${item.className}:${item.filePath || item.fileName}:${item.content.slice(0, 80)}`;
      const existing = byId.get(key);
      if (!existing) {
        byId.set(key, item);
        continue;
      }

      byId.set(key, {
        ...existing,
        certainty: Math.max(existing.certainty || 0, item.certainty || 0) || existing.certainty || item.certainty,
        score: Math.max(existing.score || 0, item.score || 0) || existing.score || item.score,
        scoreLabel: existing.scoreLabel === 'keyword' ? existing.scoreLabel : item.scoreLabel,
      });
    }
  }

  return Array.from(byId.values());
};

const countOccurrences = (text: string, term: string) => {
  if (!term) {
    return 0;
  }

  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
};

const rerankWeaviateResults = (query: string, items: WeaviateContextItem[], limit: number) => {
  const terms = extractSearchTerms(query).map(term => term.toLowerCase());
  const phrases = extractSearchPhrases(query);
  const scoredItems = items.map((item) => {
    const searchableText = [
      item.fileName,
      item.filePath,
      item.content,
    ].filter(Boolean).join('\n').toLowerCase();

    const matchedTerms = terms.filter(term => searchableText.includes(term));
    const termFrequency = matchedTerms.reduce((total, term) => total + Math.min(countOccurrences(searchableText, term), 5), 0);
    const phraseMatches = phrases.reduce((total, phrase) => total + (searchableText.includes(phrase) ? 1 : 0), 0);
    const coverage = terms.length ? matchedTerms.length / terms.length : 0;
    const normalizedWeaviateScore = typeof item.score === 'number' ? Math.min(item.score, 10) / 10 : 0;
    const normalizedCertainty = typeof item.certainty === 'number' ? item.certainty : 0;
    const filePathBoost = item.filePath && terms.some(term => item.filePath?.toLowerCase().includes(term)) ? 0.4 : 0;

    return {
      ...item,
      rerankScore: (
        phraseMatches * 3
        + coverage * 2
        + Math.min(termFrequency, 10) * 0.2
        + normalizedWeaviateScore
        + normalizedCertainty
        + filePathBoost
      ),
    };
  });

  return scoredItems
    .sort((left, right) => (
      (right.rerankScore || 0) - (left.rerankScore || 0)
      || (right.score || 0) - (left.score || 0)
      || (right.certainty || 0) - (left.certainty || 0)
    ))
    .slice(0, limit);
};

const searchWeaviateContext = async (query: string, className: string, limit: number): Promise<WeaviateContextItem[]> => {
  try {
    const exists = await weaviateClient.schema.exists(className);
    if (!exists) {
      console.warn(`Weaviate collection '${className}' does not exist; sending prompt without retrieved context.`);
      return [];
    }

    const snippetLength = Math.max(1000, Math.floor(WEAVIATE_CONTEXT_CHARS / Math.max(1, limit)));
    const candidateLimit = Math.max(limit, Math.min(100, Math.ceil(limit * Math.max(1, WEAVIATE_RERANK_CANDIDATE_MULTIPLIER))));
    const searchableProperties = ['content^3', 'fileName', 'filePath'];
    const [hybridResult, keywordResult] = await Promise.allSettled([
      weaviateClient.graphql
        .get()
        .withClassName(className)
        .withFields('content fileName filePath chunkIndex chunkCount _additional { id score }')
        .withHybrid({ query, alpha: WEAVIATE_HYBRID_ALPHA, properties: searchableProperties })
        .withLimit(candidateLimit)
        .do(),
      weaviateClient.graphql
        .get()
        .withClassName(className)
        .withFields('content fileName filePath chunkIndex chunkCount _additional { id score }')
        .withBm25({ query, properties: searchableProperties })
        .withLimit(candidateLimit)
        .do(),
    ]);

    if (hybridResult.status === 'rejected') {
      console.warn(`Weaviate hybrid lookup failed for '${className}': ${errorMessage(hybridResult.reason)}`);
    }
    if (keywordResult.status === 'rejected') {
      console.warn(`Weaviate keyword lookup failed for '${className}': ${errorMessage(keywordResult.reason)}`);
    }

    const hybridMatches = hybridResult.status === 'fulfilled'
      ? normalizeWeaviateMatches(hybridResult.value?.data?.Get?.[className] || [], className, query, 'hybrid', snippetLength)
      : [];
    const keywordMatches = keywordResult.status === 'fulfilled'
      ? normalizeWeaviateMatches(keywordResult.value?.data?.Get?.[className] || [], className, query, 'keyword', snippetLength)
      : [];

    return rerankWeaviateResults(query, mergeWeaviateResults(hybridMatches, keywordMatches), limit);
  } catch (error) {
    console.warn(`Weaviate context lookup failed; sending prompt without retrieved context: ${errorMessage(error)}`);
    return [];
  }
};

const searchWeaviateContexts = async (query: string, classNames: string[], limit: number) => {
  const perClassLimit = Math.max(1, limit);
  const resultsByClass = await Promise.all(classNames.map((className) => searchWeaviateContext(query, className, perClassLimit)));
  return resultsByClass
    .flat()
    .sort((left, right) => (
      (right.rerankScore || 0) - (left.rerankScore || 0)
      ||
      (right.score || 0) - (left.score || 0)
      || (right.certainty || 0) - (left.certainty || 0)
    ))
    .slice(0, limit);
};

const buildPromptWithWeaviateContext = async (
  message: string,
  classNames?: unknown,
  useWeaviateContext = true,
  fallbackClassName?: string,
  contextOptions = normalizeContextOptions(),
) => {
  const normalizedClassNames = normalizeWeaviateClassNames(classNames, fallbackClassName);

  if (!useWeaviateContext) {
    return {
      prompt: message,
      classNames: normalizedClassNames,
      contextCount: 0,
      contextItems: [],
    };
  }

  const contextItems = await searchWeaviateContexts(message, normalizedClassNames, contextOptions.contextResults);

  if (contextItems.length === 0) {
    return {
      prompt: message,
      classNames: normalizedClassNames,
      contextCount: 0,
      contextItems: [],
    };
  }

  const charsPerItem = Math.max(500, Math.floor(contextOptions.contextChars / contextItems.length));
  const contextBlock = contextItems.map((item, index) => {
    const sourceName = item.fileName ? `${item.className}/${item.fileName}` : item.className;
    const chunk = typeof item.chunkIndex === 'number' && typeof item.chunkCount === 'number'
      ? `, chunk ${item.chunkIndex + 1}/${item.chunkCount}`
      : '';
    const source = `Source: ${sourceName}${chunk}`;
    const relevance = typeof item.score === 'number'
      ? `, ${item.scoreLabel || 'score'} ${item.score.toFixed(3)}${typeof item.rerankScore === 'number' ? `, rerank ${item.rerankScore.toFixed(3)}` : ''}`
      : typeof item.certainty === 'number'
        ? `, certainty ${item.certainty.toFixed(3)}`
        : '';
    const link = item.sourceUrl ? `\nLink: ${item.sourceUrl}` : '';
    return `[${index + 1}] ${source}${relevance}${link}\n${truncateText(item.content, charsPerItem)}`;
  }).join('\n\n');

  return {
    prompt: [
      'Answer the user using the Weaviate context below when it is relevant. Be specific and include enough detail to be useful.',
      'When you use retrieved context, cite sources inline like [1] and include a short "Sources" section at the end with the source file names.',
      'If the context is sparse or only partially answers the question, say what is missing and answer from the available context plus the user request.',
      '',
      'Weaviate context:',
      contextBlock,
      '',
      'User request:',
      message,
    ].join('\n'),
    classNames: normalizedClassNames,
    contextCount: contextItems.length,
    contextItems,
  };
};

type ActiveOllamaStream = {
  abortController: AbortController;
  responseStream?: {
    destroy?: (error?: Error) => void;
  };
  stopped: boolean;
};

const WS_OPEN = 1;

const safeWsSend = (ws: any, message: string) => {
  try {
    if (ws.readyState === WS_OPEN) {
      ws.send(message);
    }
  } catch (error) {
    console.warn('⚠️ Skipped WebSocket send:', errorMessage(error));
  }
};

const stopActiveStream = (ws: any, reason = 'Stopped by user') => {
  const activeStream = ws.activeOllamaStream as ActiveOllamaStream | undefined;
  if (!activeStream) {
    return;
  }

  activeStream.stopped = true;
  if (!activeStream.abortController.signal.aborted) {
    activeStream.abortController.abort();
  }
  activeStream.responseStream?.destroy?.(new Error(reason));
  ws.activeOllamaStream = undefined;
};

// Store active WebSocket connections
const clients = new Set();

// WebSocket server
wss.on('connection', (ws: any, req: any) => {
  console.log('✅ WebSocket client connected');
  console.log('   Client address:', req.socket.remoteAddress);
  console.log('   Total clients:', wss.clients.size);
  clients.add(ws);

  ws.on('message', async (message: any) => {
    try {
      console.log('📨 WebSocket message received, length:', message.length);
      const data = JSON.parse(message);
      const { type, payload } = data;
      console.log('   Type:', type);

      if (type === 'stop') {
        stopActiveStream(ws);
        return;
      }

      if (type === 'message') {
        const { text, className, classNames, model, useWeaviateContext = true } = payload;
        const generationOptions = normalizeGenerationOptions(payload);
        const contextOptions = normalizeContextOptions(payload);
        console.log('👤 User message:', text);

        stopActiveStream(ws, 'Superseded by a new request');
        const activeStream: ActiveOllamaStream = {
          abortController: new AbortController(),
          stopped: false,
        };
        ws.activeOllamaStream = activeStream;

        try {
          const resolvedModel = await resolveOllamaModel(model);
          if (activeStream.stopped || activeStream.abortController.signal.aborted || ws.readyState !== WS_OPEN) {
            return;
          }
          const {
            prompt,
            classNames: contextClassNames,
            contextCount,
            contextItems,
          } = await buildPromptWithWeaviateContext(text, classNames, useWeaviateContext, className, contextOptions);
          if (activeStream.stopped || activeStream.abortController.signal.aborted || ws.readyState !== WS_OPEN) {
            return;
          }

          // Stream response from Ollama with timeout
          console.log('🔵 Sending request to Ollama...');
          console.log('   Model:', resolvedModel.model);
          if (resolvedModel.fallback) {
            console.log(`   Fallback from requested model: ${resolvedModel.requestedModel || 'none'}`);
          }
          console.log('   Prompt:', prompt.substring(0, 50));
          console.log(`   Weaviate context: ${contextCount} result(s) from ${contextClassNames.join(', ')}`);
          
          const response = await axios.post(
            `${OLLAMA_BASE_URL}/api/generate`,
            {
              model: resolvedModel.model,
              prompt,
              stream: true,
              keep_alive: OLLAMA_KEEP_ALIVE,
              temperature: generationOptions.temperature,
              top_p: generationOptions.top_p,
            },
            { 
              responseType: 'stream',
              timeout: 300000, // 5 minute timeout
              signal: activeStream.abortController.signal,
            }
          );
          if (activeStream.stopped || activeStream.abortController.signal.aborted || ws.readyState !== WS_OPEN) {
            response.data.destroy?.();
            return;
          }
          activeStream.responseStream = response.data;

          console.log('🟢 Response received from Ollama, status:', response.status);
          if (resolvedModel.fallback) {
            safeWsSend(ws, JSON.stringify({
              type: 'model',
              payload: {
                model: resolvedModel.model,
                requestedModel: resolvedModel.requestedModel,
                fallback: true,
              },
            }));
          }
          if (contextItems.length > 0) {
            safeWsSend(ws, JSON.stringify({
              type: 'context',
              payload: {
                className: contextClassNames[0],
                classNames: contextClassNames,
                count: contextCount,
                sources: contextItems.map((item, index) => ({
                  index: index + 1,
                  id: item.id,
                  className: item.className,
                  fileName: item.fileName,
                  filePath: item.filePath || item.fileName,
                  certainty: item.certainty,
                  score: item.score,
                  scoreLabel: item.scoreLabel,
                  sourceUrl: item.sourceUrl,
                })),
              },
            }));
          }
          let thinkingContext = '';
          let chunkCount = 0;
          let isStreamComplete = false;
          let streamBuffer = '';

          const handleOllamaLine = (line: string, idx: number) => {
            try {
              const json = JSON.parse(line);
              console.log(`   Line ${idx}: done=${json.done}, hasResponse=${!!json.response}, hasThinking=${!!json.thinking}`);
              if (activeStream.stopped || ws.readyState !== WS_OPEN) {
                return;
              }
              
              // Capture thinking context if present
              if (json.thinking) {
                thinkingContext += json.thinking;
                const thinkingMsg = JSON.stringify({
                  type: 'thinking',
                  payload: { text: json.thinking },
                });
                console.log('   → Sending thinking:', json.thinking.substring(0, 30));
                safeWsSend(ws, thinkingMsg);
              }
              
              // Capture response text - Ollama sends fresh text each chunk
              if (json.response) {
                const streamMsg = JSON.stringify({
                  type: 'stream',
                  payload: { text: json.response },
                });
                console.log('   → Sending stream:', json.response.substring(0, 30));
                safeWsSend(ws, streamMsg);
              }
              
              // Check if stream is done
              if (json.done) {
                isStreamComplete = true;
                console.log('🟡 Stream marked as done');
              }
            } catch (e) {
              console.error('   ❌ Error parsing JSON line:', errorMessage(e), 'Line:', line.substring(0, 50));
            }
          };
          
          response.data.on('data', (chunk: Buffer) => {
            if (isStreamComplete || activeStream.stopped || ws.readyState !== WS_OPEN) return;
            
            chunkCount++;
            console.log(`📦 Chunk ${chunkCount} received: ${chunk.length} bytes`);
            streamBuffer += chunk.toString();
            const parts = streamBuffer.split('\n');
            streamBuffer = parts.pop() || '';
            const lines = parts.filter((l: string) => l.trim());
            console.log(`   Contains ${lines.length} lines`);
            
            lines.forEach(handleOllamaLine);
          });

          response.data.on('end', () => {
            if (activeStream.stopped || ws.readyState !== WS_OPEN) {
              if (ws.activeOllamaStream === activeStream) {
                ws.activeOllamaStream = undefined;
              }
              return;
            }
            if (streamBuffer.trim() && !isStreamComplete) {
              handleOllamaLine(streamBuffer, 0);
            }
            console.log('🔴 Stream ended after', chunkCount, 'chunks');
            const completeMsg = JSON.stringify({
              type: 'complete',
              payload: { text: '', thinking: thinkingContext },
            });
            console.log('   → Sending complete message');
            safeWsSend(ws, completeMsg);
            if (ws.activeOllamaStream === activeStream) {
              ws.activeOllamaStream = undefined;
            }
          });

          response.data.on('error', (error: Error) => {
            if (activeStream.stopped || activeStream.abortController.signal.aborted) {
              if (ws.activeOllamaStream === activeStream) {
                ws.activeOllamaStream = undefined;
              }
              return;
            }
            console.error('❌ Stream error:', error.message);
            safeWsSend(ws, JSON.stringify({
              type: 'error',
              payload: { error: `Stream error: ${error.message}` },
            }));
          });
        } catch (streamError) {
          if (activeStream.stopped || activeStream.abortController.signal.aborted) {
            console.log('🛑 Ollama request aborted');
            return;
          }
          console.error('❌ Ollama request error:', ollamaErrorMessage(streamError));
          console.error('   Stack:', errorStack(streamError));
          safeWsSend(ws, JSON.stringify({
            type: 'error',
            payload: { error: `Connection error: ${ollamaErrorMessage(streamError)}` },
          }));
        } finally {
          if (ws.activeOllamaStream === activeStream && (activeStream.stopped || activeStream.abortController.signal.aborted)) {
            ws.activeOllamaStream = undefined;
          }
        }
      }
    } catch (error) {
      console.error('Error:', errorMessage(error));
      safeWsSend(ws, JSON.stringify({
        type: 'error',
        payload: { error: errorMessage(error) },
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    stopActiveStream(ws, 'WebSocket closed');
    clients.delete(ws);
  });

  ws.on('error', (error: Error) => {
    console.error('WebSocket error:', error);
  });
});

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL_NAME });
});

app.get('/api/weaviate/health', async (req, res) => {
  try {
    const ready = await weaviateClient.misc.readyChecker().do();
    res.json({ status: ready ? 'ready' : 'not_ready', url: WEAVIATE_URL });
  } catch (error) {
    res.status(503).json({
      status: 'unavailable',
      url: WEAVIATE_URL,
      error: isConnectionRefused(error) ? weaviateUnavailableMessage() : errorMessage(error),
    });
  }
});

app.get('/api/weaviate/collections', async (req, res) => {
  try {
    const schema = await weaviateClient.schema.getter().do();
    const collections = (schema.classes || [])
      .filter((cls: any) => Array.isArray(cls.properties) && cls.properties.some((property: any) => property.name === 'content'))
      .map((cls: any) => ({
        name: cls.class,
        description: cls.description,
        vectorizer: cls.vectorizer,
      }))
      .sort((left: any, right: any) => left.name.localeCompare(right.name));

    res.json({
      defaultCollection: DEFAULT_WEAVIATE_FILE_CLASS,
      collections,
    });
  } catch (error) {
    console.error('Weaviate collection list error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/weaviate/collections', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.body?.className);
    await ensureFileCollection(className);
    res.json({
      collection: {
        name: className,
        description: 'Files uploaded from the frontend',
        vectorizer: 'text2vec-transformers',
      },
    });
  } catch (error) {
    console.error('Weaviate collection create error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.delete('/api/weaviate/collections/:className', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.params.className);
    const exists = await weaviateClient.schema.exists(className);
    if (!exists) {
      res.status(404).json({ error: `Weaviate library "${className}" does not exist.` });
      return;
    }

    await weaviateClient.schema.classDeleter().withClassName(className).do();
    res.json({ deleted: className });
  } catch (error) {
    console.error('Weaviate collection delete error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get('/api/weaviate/source/:className/:id', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.params.className);
    const id = req.params.id;
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      res.status(400).send('Invalid source id.');
      return;
    }

    const source = await weaviateClient.data
      .getterById()
      .withClassName(className)
      .withId(id)
      .do();

    const properties = source?.properties || {};
    const fileName = typeof properties.fileName === 'string' ? properties.fileName : 'source.txt';
    const filePath = typeof properties.filePath === 'string' ? properties.filePath : fileName;
    const content = typeof properties.content === 'string' ? properties.content : '';
    const chunkIndex = typeof properties.chunkIndex === 'number' ? properties.chunkIndex : undefined;
    const chunkCount = typeof properties.chunkCount === 'number' ? properties.chunkCount : undefined;
    const chunkLine = typeof chunkIndex === 'number' && typeof chunkCount === 'number'
      ? [`Chunk: ${chunkIndex + 1}/${chunkCount}`, '']
      : [];

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    res.send([`Source: ${filePath}`, ...chunkLine, content].join('\n'));
  } catch (error) {
    console.error('Weaviate source lookup error:', errorMessage(error));
    res.status(404).send(`Source not found: ${errorMessage(error)}`);
  }
});

app.get('/api/weaviate/collections/:className/files', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.params.className);
    const exists = await weaviateClient.schema.exists(className);
    if (!exists) {
      res.status(404).json({ error: `Weaviate library "${className}" does not exist.` });
      return;
    }

    const result = await weaviateClient.graphql
      .get()
      .withClassName(className)
      .withFields('fileName filePath fileId mimeType size uploadedAt chunkIndex chunkCount _additional { id }')
      .withLimit(10000)
      .do();

    const filesByPath = new Map<string, any>();
    for (const file of result?.data?.Get?.[className] || []) {
      const id = file._additional?.id;
      const filePath = file.filePath || file.fileName;
      if (typeof id !== 'string' || typeof filePath !== 'string') {
        continue;
      }
      const existing = filesByPath.get(filePath);
      filesByPath.set(filePath, {
        id: existing?.id || id,
        fileName: file.fileName,
        filePath,
        fileId: file.fileId,
        mimeType: file.mimeType,
        size: file.size,
        uploadedAt: file.uploadedAt,
        chunkCount: Math.max(existing?.chunkCount || 1, file.chunkCount || 1),
      });
    }

    const files = Array.from(filesByPath.values())
      .sort((left: any, right: any) => (left.filePath || '').localeCompare(right.filePath || ''));

    res.json({ className, files, count: files.length });
  } catch (error) {
    console.error('Weaviate file list error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.delete('/api/weaviate/collections/:className/files/:id', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.params.className);
    const id = req.params.id;
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      res.status(400).json({ error: 'Invalid file id.' });
      return;
    }

    const source = await weaviateClient.data
      .getterById()
      .withClassName(className)
      .withId(id)
      .do();
    const filePath = source?.properties?.filePath;

    if (typeof filePath !== 'string' || !filePath.trim()) {
      await weaviateClient.data
        .deleter()
        .withClassName(className)
        .withId(id)
        .do();

      res.json({ deleted: id, className, deletedCount: 1 });
      return;
    }

    const matchingChunks = await weaviateClient.graphql
      .get()
      .withClassName(className)
      .withFields('_additional { id }')
      .withWhere({
        path: ['filePath'],
        operator: 'Equal',
        valueText: filePath,
      })
      .withLimit(10000)
      .do();

    const chunkIds: string[] = (matchingChunks?.data?.Get?.[className] || [])
      .map((chunk: any) => chunk._additional?.id)
      .filter((chunkId: unknown): chunkId is string => typeof chunkId === 'string');

    await Promise.all(chunkIds.map((chunkId) => weaviateClient.data
      .deleter()
      .withClassName(className)
      .withId(chunkId)
      .do()));

    res.json({ deleted: id, className, filePath, deletedCount: chunkIds.length });
  } catch (error) {
    console.error('Weaviate file delete error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, className, classNames, model, useWeaviateContext = true } = req.body;
    const generationOptions = normalizeGenerationOptions(req.body);
    const contextOptions = normalizeContextOptions(req.body);
    const resolvedModel = await resolveOllamaModel(model);
    const {
      prompt,
      classNames: contextClassNames,
      contextCount,
      contextItems,
    } = await buildPromptWithWeaviateContext(message, classNames, useWeaviateContext, className, contextOptions);
    
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: resolvedModel.model,
      prompt,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      temperature: generationOptions.temperature,
      top_p: generationOptions.top_p,
    });

    res.json({
      response: response.data.response,
      weaviate: {
        className: contextClassNames[0],
        classNames: contextClassNames,
        contextCount,
        sources: contextItems.map((item, index) => ({
          index: index + 1,
          id: item.id,
          className: item.className,
          fileName: item.fileName,
          filePath: item.filePath || item.fileName,
          certainty: item.certainty,
          score: item.score,
          scoreLabel: item.scoreLabel,
          sourceUrl: item.sourceUrl,
        })),
      },
      model: {
        name: resolvedModel.model,
        requested: resolvedModel.requestedModel,
        fallback: resolvedModel.fallback,
      },
    });
  } catch (error) {
    console.error('Error:', ollamaErrorMessage(error));
    res.status(500).json({ error: ollamaErrorMessage(error) });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const models = await getInstalledOllamaModels();
    res.json({
      defaultModel: MODEL_NAME,
      suggestedModels: SUGGESTED_MODELS,
      models,
    });
  } catch (error) {
    console.error('Error:', errorMessage(error));
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/pull-model', async (req, res) => {
  try {
    const { model } = req.body;
    
    const response = await axios.post(
      `${OLLAMA_BASE_URL}/api/pull`,
      { name: model },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', 'application/json');
    response.data.pipe(res);
  } catch (error) {
    console.error('Error:', errorMessage(error));
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/weaviate/upload', async (req, res) => {
  try {
    const className = normalizeWeaviateClassName(req.body?.className);
    const files = validateUploadedFiles(req.body?.files);
    await ensureFileCollection(className);

    const uploadedAt = new Date().toISOString();
    const uploaded = [];
    const skippedDuplicates = [];

    for (const file of files) {
      const existingFile = await findExistingFileByPath(className, file.path);
      if (existingFile) {
        skippedDuplicates.push({
          id: existingFile._additional?.id,
          fileName: file.name,
          filePath: file.path,
          reason: 'already exists',
        });
        continue;
      }

      const chunks = splitContentIntoChunks(file.content);
      const fileId = createFileId(file.path);
      let firstChunkId = '';

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const result = await weaviateClient.data.creator()
          .withClassName(className)
          .withProperties({
            content: chunks[chunkIndex],
            fileName: file.name,
            filePath: file.path,
            fileId,
            chunkIndex,
            chunkCount: chunks.length,
            mimeType: file.type,
            size: file.size,
            uploadedAt,
          })
          .do();

        if (!firstChunkId && typeof result.id === 'string') {
          firstChunkId = result.id;
        }
      }

      uploaded.push({
        id: firstChunkId,
        fileName: file.name,
        filePath: file.path,
        size: file.size,
        chunkCount: chunks.length,
      });
    }

    res.json({
      className,
      uploaded,
      count: uploaded.length,
      skippedDuplicates,
      skippedDuplicateCount: skippedDuplicates.length,
    });
  } catch (error) {
    console.error('Weaviate upload error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      res.status(503).json({ error: weaviateUnavailableMessage() });
      return;
    }
    res.status(400).json({ error: errorMessage(error) });
  }
});

// Serve static files from frontend
app.use(express.static('../frontend/dist'));

// MCP Protocol implementation (basic)
app.post('/mcp/request', async (req, res) => {
  try {
    const { method, params } = req.body;

    if (method === 'resources/list') {
      res.json({
        resources: [
          {
            uri: 'gemma://model',
            name: 'Gemma Model',
            description: 'Ollama Gemma model interface',
            mimeType: 'application/json',
          },
          {
            uri: 'weaviate://collections',
            name: 'Weaviate Collections',
            description: 'List of all Weaviate collections',
            mimeType: 'application/json',
          },
        ],
      });
    } else if (method === 'tools/list') {
      res.json({
        tools: [
          {
            name: 'query_model',
            description: 'Query the Gemma model with a prompt',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The prompt to send to the model' },
                model: { type: 'string', description: 'Optional Ollama model tag to use' },
                temperature: { type: 'number', description: 'Model temperature (0-1)' },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'weaviate_create_collection',
            description: 'Create a new Weaviate collection/class',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: 'Name of the collection to create' },
                description: { type: 'string', description: 'Description of the collection' },
                vectorizer: { type: 'string', description: 'Vectorizer module to use (e.g., text2vec-transformers)' },
              },
              required: ['className'],
            },
          },
          {
            name: 'weaviate_add_document',
            description: 'Add a document to a Weaviate collection',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: 'Name of the collection' },
                content: { type: 'string', description: 'Text content of the document' },
                properties: { type: 'object', description: 'Additional properties for the document' },
              },
              required: ['className', 'content'],
            },
          },
          {
            name: 'weaviate_search',
            description: 'Search documents in a Weaviate collection using semantic search',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: 'Name of the collection to search' },
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Maximum number of results to return' },
              },
              required: ['className', 'query'],
            },
          },
          {
            name: 'weaviate_list_collections',
            description: 'List all collections in Weaviate',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      if (name === 'query_model') {
        const resolvedModel = await resolveOllamaModel(args.model);
        const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
          model: resolvedModel.model,
          prompt: args.prompt,
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          temperature: args.temperature || 0.7,
        });

        res.json({
          result: response.data.response,
          model: {
            name: resolvedModel.model,
            requested: resolvedModel.requestedModel,
            fallback: resolvedModel.fallback,
          },
        });
      } else if (name === 'weaviate_create_collection') {
        try {
          const schema = {
            class: args.className,
            description: args.description || '',
            vectorizer: args.vectorizer || 'text2vec-transformers',
            vectorIndexType: 'hnsw',
            vectorIndexConfig: weaviateVectorIndexConfig(),
            properties: [
              {
                name: 'content',
                dataType: ['text'],
                description: 'The text content of the document',
              },
            ],
          };

          await weaviateClient.schema.classCreator().withClass(schema).do();
          res.json({ result: `Collection '${args.className}' created successfully` });
        } catch (error) {
          res.status(500).json({ error: `Failed to create collection: ${errorMessage(error)}` });
        }
      } else if (name === 'weaviate_add_document') {
        try {
          const obj = {
            class: args.className,
            properties: {
              content: args.content,
              ...args.properties,
            },
          };

          const result = await weaviateClient.data.creator().withClassName(args.className).withProperties(obj.properties).do();
          res.json({ result: `Document added with ID: ${result.id}` });
        } catch (error) {
          res.status(500).json({ error: `Failed to add document: ${errorMessage(error)}` });
        }
      } else if (name === 'weaviate_search') {
        try {
          const result = await weaviateClient.graphql
            .get()
            .withClassName(args.className)
            .withFields('content _additional { id certainty }')
            .withNearText({ concepts: [args.query] })
            .withLimit(args.limit || 10)
            .do();

          res.json({ result: result.data.Get[args.className] });
        } catch (error) {
          res.status(500).json({ error: `Failed to search: ${errorMessage(error)}` });
        }
      } else if (name === 'weaviate_list_collections') {
        try {
          const schema = await weaviateClient.schema.getter().do();
          const collections = (schema.classes || []).map((cls: any) => ({
            name: cls.class,
            description: cls.description,
            vectorizer: cls.vectorizer,
          }));
          res.json({ result: collections });
        } catch (error) {
          res.status(500).json({ error: `Failed to list collections: ${errorMessage(error)}` });
        }
      }
    } else if (method === 'resources/read') {
      const { uri } = req.body;
      if (uri === 'weaviate://collections') {
        try {
          const schema = await weaviateClient.schema.getter().do();
          const collections = (schema.classes || []).map((cls: any) => ({
            name: cls.class,
            description: cls.description,
            vectorizer: cls.vectorizer,
            properties: cls.properties,
          }));
          res.json({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(collections, null, 2) }] });
        } catch (error) {
          res.status(500).json({ error: `Failed to read collections: ${errorMessage(error)}` });
        }
      } else {
        res.status(404).json({ error: 'Resource not found' });
      }
    } else {
      res.status(400).json({ error: 'Unknown method' });
    }
  } catch (error) {
    console.error('MCP Error:', errorMessage(error));
    res.status(500).json({ error: errorMessage(error) });
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const handleServerListenError = (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Backend failed to start: port ${API_PORT} is already in use.`);
    console.error('   Stop the process using that port or set API_PORT to a free port and update VITE_BACKEND_URL/VITE_WS_URL.');
  } else if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error(`❌ Backend failed to start: permission denied while binding to port ${API_PORT}.`);
    console.error('   Use an allowed port or update API_PORT in backend/.env.');
  } else {
    console.error('❌ Backend failed to start:', error);
  }
  process.exit(1);
};

server.on('error', handleServerListenError);
wss.on('error', handleServerListenError);

// Start server
server.listen(API_PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${API_PORT}`);
  console.log(`📡 WebSocket server on ws://localhost:${API_PORT}`);
  console.log(`🤖 Connected to Ollama at ${OLLAMA_BASE_URL}`);
  console.log(`📦 Using model: ${MODEL_NAME}`);
  console.log(`🗄️  Weaviate configured at ${WEAVIATE_URL}`);
});
