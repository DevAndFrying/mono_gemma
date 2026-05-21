import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import weaviate from 'weaviate-ts-client';
import pg from 'pg';

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
const MODEL_NAME = process.env.MODEL_NAME || 'gemma4:26b';
const API_PORT = process.env.API_PORT || 3000;
const MCP_PORT = process.env.MCP_PORT || 3001;
const WEAVIATE_URL = process.env.WEAVIATE_URL || 'http://localhost:8080';
const DEFAULT_WEAVIATE_FILE_CLASS = process.env.WEAVIATE_FILE_CLASS || 'uploaded_files';
const MAX_UPLOAD_FILE_BYTES = Number(process.env.MAX_UPLOAD_FILE_BYTES || 20 * 1024 * 1024);
const WEAVIATE_CONTEXT_RESULTS = Number(process.env.WEAVIATE_CONTEXT_RESULTS || 12);
const WEAVIATE_CONTEXT_CHARS = Number(process.env.WEAVIATE_CONTEXT_CHARS || 32000);
const WEAVIATE_ENABLE_PQ = process.env.WEAVIATE_ENABLE_PQ === 'true';
const WEAVIATE_PQ_TRAINING_LIMIT = Number(process.env.WEAVIATE_PQ_TRAINING_LIMIT || 50000);
const WEAVIATE_UPLOAD_CHUNK_CHARS = Number(process.env.WEAVIATE_UPLOAD_CHUNK_CHARS || 900);
const WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS = Number(process.env.WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS || 120);
const WEAVIATE_UPLOAD_MIN_CHUNK_CHARS = Number(process.env.WEAVIATE_UPLOAD_MIN_CHUNK_CHARS || 400);
const WEAVIATE_UPLOAD_CHUNK_DELAY_MS = Number(process.env.WEAVIATE_UPLOAD_CHUNK_DELAY_MS || 200);
const WEAVIATE_UPLOAD_CHUNK_RETRIES = Number(process.env.WEAVIATE_UPLOAD_CHUNK_RETRIES || 6);
const WEAVIATE_UPLOAD_MAX_CHUNKS_PER_REQUEST = Number(process.env.WEAVIATE_UPLOAD_MAX_CHUNKS_PER_REQUEST || 8);
const WEAVIATE_HYBRID_ALPHA = Number(process.env.WEAVIATE_HYBRID_ALPHA || 0.35);
const WEAVIATE_RERANK_CANDIDATE_MULTIPLIER = Number(process.env.WEAVIATE_RERANK_CANDIDATE_MULTIPLIER || 2);
const WEAVIATE_SEARCH_MAX_CANDIDATES = Number(process.env.WEAVIATE_SEARCH_MAX_CANDIDATES || 24);
const WEAVIATE_SEARCH_MODE = (process.env.WEAVIATE_SEARCH_MODE || 'hybrid').toLowerCase();
const WEAVIATE_SEARCH_SNIPPET_CHARS = Number(process.env.WEAVIATE_SEARCH_SNIPPET_CHARS || 1200);
const OLLAMA_MODEL_CACHE_MS = Number(process.env.OLLAMA_MODEL_CACHE_MS || 30000);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m';
const HTTP_RESPONSE_HEARTBEAT_MS = Number(process.env.HTTP_RESPONSE_HEARTBEAT_MS || 5000);
const HTTP_REQUEST_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 15 * 60 * 1000);
const HTTP_HEADERS_TIMEOUT_MS = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || HTTP_REQUEST_TIMEOUT_MS + 5000);
const HTTP_KEEP_ALIVE_TIMEOUT_MS = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 65000);
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 25000);
const SUGGESTED_MODELS = (process.env.SUGGESTED_MODELS || 'gemma4:26b,gemma4:e4b,gemma4:31b')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const weaviateUrl = new URL(WEAVIATE_URL);
const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const databaseUrlPassword = DATABASE_URL ? new URL(DATABASE_URL).password : '';
const postgresPassword = String(process.env.PGPASSWORD || databaseUrlPassword || 'mcp_dev_password');
const postgresPoolConfig = DATABASE_URL
  ? { connectionString: DATABASE_URL, password: postgresPassword }
  : {
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'mcp_gemma',
      user: process.env.PGUSER || 'mcp',
      password: postgresPassword,
    };
const postgresPool = new Pool(postgresPoolConfig);

// Initialize Weaviate client
const weaviateClient = weaviate.client({
  scheme: weaviateUrl.protocol.replace(':', ''),
  host: weaviateUrl.host,
});

// Middleware
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));

server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
server.timeout = HTTP_REQUEST_TIMEOUT_MS;

const startJsonHeartbeat = (res: Response) => {
  let hasWritten = false;
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }

    if (!hasWritten) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      hasWritten = true;
    }

    res.write('\n');
  }, HTTP_RESPONSE_HEARTBEAT_MS);

  return {
    stop: () => clearInterval(timer),
    writeJson: (statusCode: number, body: unknown) => {
      clearInterval(timer);
      if (!res.headersSent) {
        res.status(statusCode);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.end(JSON.stringify(body));
    },
  };
};

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
  fileId?: string;
  sectionTitle?: string;
  sectionPath?: string;
  chunkType?: string;
  language?: string;
  certainty?: number;
  score?: number;
  scoreLabel?: string;
  rerankScore?: number;
  chunkIndex?: number;
  chunkCount?: number;
  startLine?: number;
  endLine?: number;
  sourceUrl?: string;
};

type UploadChunkBlock = {
  type: 'paragraph' | 'table' | 'code';
  text: string;
  sectionTitle?: string;
  sectionPath?: string;
  language?: string;
  startLine: number;
  endLine: number;
};

type UploadChunk = {
  content: string;
  chunkType: UploadChunkBlock['type'];
  sectionTitle?: string;
  sectionPath?: string;
  language?: string;
  startLine: number;
  endLine: number;
};

type OllamaModel = {
  name: string;
};

let ollamaModelCache: { models: string[]; expiresAt: number } | null = null;
let databaseReadyPromise: Promise<void> | null = null;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorStack = (error: unknown) => error instanceof Error ? error.stack : undefined;
const isConnectionRefused = (error: unknown) => errorMessage(error).includes('ECONNREFUSED');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeAskedQuestion = (question: unknown) => (
  typeof question === 'string'
    ? question.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
);
const createChatId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const validateChatMessages = (messages: unknown) => {
  if (!Array.isArray(messages)) {
    throw new Error('Chat messages must be an array.');
  }

  return messages.map((message) => {
    if (!message || typeof message !== 'object') {
      throw new Error('Each chat message must be an object.');
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (typeof role !== 'string' || !role.trim()) {
      throw new Error('Each chat message must include a role.');
    }
    if (typeof content !== 'string') {
      throw new Error('Each chat message must include string content.');
    }
    return message;
  });
};
const ensureDatabase = async () => {
  if (!databaseReadyPromise) {
    databaseReadyPromise = (async () => {
      await postgresPool.query(`
        CREATE TABLE IF NOT EXISTS saved_chats (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          model TEXT,
          messages JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await postgresPool.query(`
        CREATE TABLE IF NOT EXISTS top_asked_questions (
          normalized_question TEXT PRIMARY KEY,
          display_question TEXT NOT NULL,
          ask_count INTEGER NOT NULL DEFAULT 1,
          first_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_asked_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await postgresPool.query(`
        CREATE INDEX IF NOT EXISTS top_asked_questions_count_idx
        ON top_asked_questions (ask_count DESC, last_asked_at DESC);
      `);
    })().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }

  return databaseReadyPromise;
};
const toSavedChat = (row: any) => ({
  id: row.id,
  title: row.title,
  model: row.model,
  messages: row.messages,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const upsertSavedChat = async ({ id, title, model, messages }: {
  id?: string;
  title: string;
  model?: string;
  messages: unknown[];
}) => {
  await ensureDatabase();
  const chatId = typeof id === 'string' && id.trim() ? id.trim() : createChatId();
  const result = await postgresPool.query(
    `
      INSERT INTO saved_chats (id, title, model, messages)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        model = EXCLUDED.model,
        messages = EXCLUDED.messages,
        updated_at = now()
      RETURNING id, title, model, messages, created_at, updated_at;
    `,
    [chatId, title, model || null, JSON.stringify(messages)]
  );
  return toSavedChat(result.rows[0]);
};
const recordAskedQuestion = async (question: unknown) => {
  const displayQuestion = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
  const normalizedQuestion = normalizeAskedQuestion(displayQuestion);
  if (!normalizedQuestion) {
    return;
  }

  await ensureDatabase();
  await postgresPool.query(
    `
      INSERT INTO top_asked_questions (normalized_question, display_question)
      VALUES ($1, $2)
      ON CONFLICT (normalized_question) DO UPDATE SET
        display_question = EXCLUDED.display_question,
        ask_count = top_asked_questions.ask_count + 1,
        last_asked_at = now();
    `,
    [normalizedQuestion, displayQuestion]
  );
};
const trackAskedQuestionMiddleware = (req: Request, res: Response, next: NextFunction) => {
  recordAskedQuestion(req.body?.message).catch((error) => {
    console.error('Question analytics error:', errorMessage(error));
  });
  next();
};
const isTransientWeaviateVectorizerError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status && [408, 429, 502, 503, 504].includes(status)) {
      return true;
    }
  }

  const message = errorMessage(error).toLowerCase();
  return [
    'connection reset by peer',
    'econnreset',
    'econnaborted',
    'etimedout',
    'read tcp',
    't2v-transformers',
    '/vectors',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    'gateway time-out',
    'request failed with status code 504',
    'context deadline exceeded',
    'timeout awaiting response headers',
    'upstream request timeout',
  ].some((fragment) => message.includes(fragment));
};
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
    name: 'chunkType',
    dataType: ['text'],
    description: 'Structural type of this chunk, such as paragraph, table, or code',
  },
  {
    name: 'sectionTitle',
    dataType: ['text'],
    description: 'Nearest heading or structural title for this chunk',
  },
  {
    name: 'sectionPath',
    dataType: ['text'],
    description: 'Heading path that locates this chunk within the uploaded file',
  },
  {
    name: 'language',
    dataType: ['text'],
    description: 'Detected code or document language for this chunk',
  },
  {
    name: 'startLine',
    dataType: ['int'],
    description: 'One-based starting line for this chunk in the uploaded file',
  },
  {
    name: 'endLine',
    dataType: ['int'],
    description: 'One-based ending line for this chunk in the uploaded file',
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
  top_p: clampNumber(options.top_p, 0.95, 0.05, 1),
});

const normalizeContextOptions = (options: { contextChars?: unknown; contextResults?: unknown } = {}) => ({
  contextChars: Math.round(clampNumber(options.contextChars, WEAVIATE_CONTEXT_CHARS, 1000, 64000)),
  contextResults: Math.round(clampNumber(options.contextResults, WEAVIATE_CONTEXT_RESULTS, 1, 12)),
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
    .withFields('fileName filePath chunkCount _additional { id }')
    .withWhere({
      path: ['filePath'],
      operator: 'Equal',
      valueText: filePath,
    })
    .withLimit(1)
    .do();

  return result?.data?.Get?.[className]?.[0] || null;
};

const findFileChunkIdsByPath = async (className: string, filePath: string) => {
  const result = await weaviateClient.graphql
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

  return (result?.data?.Get?.[className] || [])
    .map((chunk: any) => chunk._additional?.id)
    .filter((chunkId: unknown): chunkId is string => typeof chunkId === 'string');
};

const deleteFileChunksByPath = async (className: string, filePath: string) => {
  const chunkIds = await findFileChunkIdsByPath(className, filePath);
  await Promise.all(chunkIds.map((chunkId: string) => weaviateClient.data
    .deleter()
    .withClassName(className)
    .withId(chunkId)
    .do()));
  return chunkIds.length;
};

const createFileId = (filePath: string) => Buffer.from(filePath).toString('base64url').slice(0, 96);

const createWeaviateChunkWithRetry = async (className: string, properties: Record<string, unknown>) => {
  let lastError: unknown;
  const retries = Math.max(0, Math.floor(WEAVIATE_UPLOAD_CHUNK_RETRIES));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await weaviateClient.data.creator()
        .withClassName(className)
        .withProperties(properties)
        .do();
    } catch (error) {
      lastError = error;
      if (!isTransientWeaviateVectorizerError(error) || attempt >= retries) {
        throw error;
      }

      const delayMs = 500 * (attempt + 1) * (attempt + 1);
      console.warn(`Weaviate vectorizer reset while uploading chunk ${Number(properties.chunkIndex) + 1}/${properties.chunkCount}; retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }

  throw lastError;
};

const splitContentIntoChunks = (content: string, filePath = '', mimeType = ''): UploadChunk[] => {
  const normalizedChunkChars = Math.max(WEAVIATE_UPLOAD_MIN_CHUNK_CHARS, WEAVIATE_UPLOAD_CHUNK_CHARS);
  const normalizedOverlapChars = Math.min(
    Math.max(0, WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS),
    Math.floor(normalizedChunkChars / 2),
  );
  const fallbackLanguage = detectLanguage(filePath, mimeType);
  const fallbackSectionTitle = filePath.split('/').filter(Boolean).pop() || 'Uploaded file';

  if (content.length <= normalizedChunkChars) {
    return [{
      content: formatChunkContent(content.trim(), fallbackSectionTitle, fallbackSectionTitle, fallbackLanguage),
      chunkType: isCodeLanguage(fallbackLanguage) ? 'code' : 'paragraph',
      sectionTitle: fallbackSectionTitle,
      sectionPath: fallbackSectionTitle,
      language: fallbackLanguage,
      startLine: 1,
      endLine: Math.max(1, content.split('\n').length),
    }];
  }

  const blocks = splitContentIntoChunkBlocks(content, filePath, mimeType);
  const chunks: UploadChunk[] = [];
  let currentBlocks: UploadChunkBlock[] = [];
  let currentText = '';
  let carryOverlap = '';

  const pushCurrentChunk = () => {
    const chunkText = currentText.trim();
    if (chunkText && currentBlocks.length > 0) {
      const firstBlock = currentBlocks[0];
      const lastBlock = currentBlocks[currentBlocks.length - 1];
      const metadataBlock = lastBlock.sectionPath ? lastBlock : firstBlock;
      chunks.push({
        content: formatChunkContent(chunkText, metadataBlock.sectionTitle, metadataBlock.sectionPath, metadataBlock.language),
        chunkType: currentBlocks.some(block => block.type === 'code') ? 'code' : currentBlocks.some(block => block.type === 'table') ? 'table' : 'paragraph',
        sectionTitle: metadataBlock.sectionTitle,
        sectionPath: metadataBlock.sectionPath,
        language: metadataBlock.language || fallbackLanguage,
        startLine: firstBlock.startLine,
        endLine: lastBlock.endLine,
      });
      carryOverlap = getChunkOverlapText(chunkText, normalizedOverlapChars);
    }
    currentBlocks = [];
    currentText = '';
  };

  for (const block of blocks) {
    const blockText = block.text.trim();
    if (!blockText) {
      continue;
    }

    if (blockText.length > normalizedChunkChars) {
      pushCurrentChunk();
      const oversizedText = block.type === 'table'
        ? blockText
        : carryOverlap ? `${carryOverlap}\n\n${blockText}` : blockText;
      const oversizedChunks = block.type === 'table'
        ? splitLargeTableBlock(oversizedText, normalizedChunkChars, normalizedOverlapChars)
        : splitTextByCharacterWindow(oversizedText, normalizedChunkChars, normalizedOverlapChars);
      chunks.push(...oversizedChunks.map((chunkText) => ({
        content: formatChunkContent(chunkText, block.sectionTitle, block.sectionPath, block.language || fallbackLanguage),
        chunkType: block.type,
        sectionTitle: block.sectionTitle,
        sectionPath: block.sectionPath,
        language: block.language || fallbackLanguage,
        startLine: block.startLine,
        endLine: block.endLine,
      })));
      carryOverlap = getChunkOverlapText(oversizedChunks[oversizedChunks.length - 1] || '', normalizedOverlapChars);
      continue;
    }

    const baseChunk = currentText || carryOverlap;
    const candidateChunk = baseChunk ? `${baseChunk}\n\n${blockText}` : blockText;
    if (candidateChunk.length <= normalizedChunkChars) {
      currentText = candidateChunk;
      currentBlocks.push(block);
      carryOverlap = '';
      continue;
    }

    pushCurrentChunk();
    const chunkWithOverlap = carryOverlap ? `${carryOverlap}\n\n${blockText}` : blockText;
    currentText = chunkWithOverlap.length <= normalizedChunkChars ? chunkWithOverlap : blockText;
    currentBlocks = [block];
    carryOverlap = '';
  }

  pushCurrentChunk();

  if (chunks.length > 0) {
    return chunks;
  }

  return splitTextByCharacterWindow(content, normalizedChunkChars, normalizedOverlapChars).map((chunkText) => ({
    content: formatChunkContent(chunkText, fallbackSectionTitle, fallbackSectionTitle, fallbackLanguage),
    chunkType: isCodeLanguage(fallbackLanguage) ? 'code' : 'paragraph',
    sectionTitle: fallbackSectionTitle,
    sectionPath: fallbackSectionTitle,
    language: fallbackLanguage,
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
  }));
};

const formatChunkContent = (text: string, sectionTitle?: string, sectionPath?: string, language?: string) => {
  const metadataLines = [
    sectionPath ? `Section: ${sectionPath}` : sectionTitle ? `Section: ${sectionTitle}` : '',
    language ? `Language: ${language}` : '',
  ].filter(Boolean);

  return metadataLines.length > 0 ? `${metadataLines.join('\n')}\n\n${text}` : text;
};

const detectLanguage = (filePath: string, mimeType = '') => {
  const extension = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const byExtension: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mdx: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'text',
    yaml: 'yaml',
    yml: 'yaml',
  };

  if (byExtension[extension]) {
    return byExtension[extension];
  }
  if (mimeType.includes('markdown')) {
    return 'markdown';
  }
  if (mimeType.includes('json')) {
    return 'json';
  }
  if (mimeType.startsWith('text/')) {
    return 'text';
  }
  return '';
};

const isCodeLanguage = (language = '') => (
  ['c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'python', 'ruby', 'rust', 'shell', 'sql', 'typescript', 'yaml'].includes(language)
);

const splitTextByCharacterWindow = (content: string, chunkChars: number, overlapChars: number) => {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const hardEnd = Math.min(content.length, start + chunkChars);
    let end = hardEnd;
    if (hardEnd < content.length) {
      const breakWindowStart = Math.max(start + Math.floor(chunkChars * 0.6), hardEnd - 600);
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
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
};

const getChunkOverlapText = (text: string, overlapChars: number) => {
  if (overlapChars <= 0 || !text.trim()) {
    return '';
  }

  const overlap = text.slice(-overlapChars).trim();
  const cleanStart = Math.max(
    overlap.indexOf('\n\n'),
    overlap.indexOf('\n'),
    overlap.indexOf('. '),
    overlap.indexOf('? '),
    overlap.indexOf('! '),
  );

  return cleanStart > 0 ? overlap.slice(cleanStart + 1).trim() : overlap;
};

const isMarkdownTableRow = (line: string) => {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.replace(/\\\|/g, '').split('|').length >= 3;
};

const isMarkdownTableSeparator = (line: string) => (
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
);

const isMarkdownTableStart = (lines: string[], index: number) => (
  isMarkdownTableRow(lines[index] || '')
  && isMarkdownTableSeparator(lines[index + 1] || '')
);

const splitContentIntoChunkBlocks = (content: string, filePath = '', mimeType = ''): UploadChunkBlock[] => {
  const fallbackLanguage = detectLanguage(filePath, mimeType);
  if (isCodeLanguage(fallbackLanguage) && fallbackLanguage !== 'markdown') {
    return splitSourceCodeIntoChunkBlocks(content, filePath, fallbackLanguage);
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: UploadChunkBlock[] = [];
  const headingStack: string[] = [];
  const fallbackSectionTitle = filePath.split('/').filter(Boolean).pop() || 'Uploaded file';
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) {
      index += 1;
    }

    if (index >= lines.length) {
      break;
    }

    const headingMatch = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      headingStack.splice(level - 1);
      headingStack[level - 1] = headingMatch[2].trim();
      index += 1;
      continue;
    }

    const activeHeadings = headingStack.filter(Boolean);
    const sectionPath = activeHeadings.join(' > ') || fallbackSectionTitle;
    const sectionTitle = activeHeadings[activeHeadings.length - 1] || fallbackSectionTitle;

    const fencedCodeMatch = lines[index].match(/^```([A-Za-z0-9_+.-]*)\s*$/);
    if (fencedCodeMatch) {
      const startLine = index + 1;
      const codeLines = [lines[index]];
      index += 1;
      while (index < lines.length) {
        codeLines.push(lines[index]);
        const isFenceEnd = /^```\s*$/.test(lines[index]);
        index += 1;
        if (isFenceEnd) {
          break;
        }
      }
      blocks.push({
        type: 'code',
        text: codeLines.join('\n'),
        sectionTitle,
        sectionPath,
        language: fencedCodeMatch[1] || fallbackLanguage,
        startLine,
        endLine: index,
      });
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableLines: string[] = [];
      const startLine = index + 1;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push({
        type: 'table',
        text: tableLines.join('\n'),
        sectionTitle,
        sectionPath,
        language: fallbackLanguage,
        startLine,
        endLine: index,
      });
      continue;
    }

    const paragraphLines: string[] = [];
    const startLine = index + 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !isMarkdownTableStart(lines, index)
      && !lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      && !lines[index].match(/^```([A-Za-z0-9_+.-]*)\s*$/)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join('\n'),
      sectionTitle,
      sectionPath,
      language: fallbackLanguage,
      startLine,
      endLine: index,
    });
  }

  return blocks;
};

const splitSourceCodeIntoChunkBlocks = (content: string, filePath: string, language: string): UploadChunkBlock[] => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: UploadChunkBlock[] = [];
  const fallbackSectionTitle = filePath.split('/').filter(Boolean).pop() || 'Source file';
  const boundaryPattern = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|async def|struct|impl|func|public|private|protected|static)\b/;
  let start = 0;

  const pushBlock = (endExclusive: number) => {
    const text = lines.slice(start, endExclusive).join('\n').trim();
    if (!text) {
      start = endExclusive;
      return;
    }
    const titleLine = text.split('\n').find(line => boundaryPattern.test(line.trim())) || fallbackSectionTitle;
    blocks.push({
      type: 'code',
      text,
      sectionTitle: titleLine.trim().slice(0, 120),
      sectionPath: `${fallbackSectionTitle} > ${titleLine.trim().slice(0, 120)}`,
      language,
      startLine: start + 1,
      endLine: endExclusive,
    });
    start = endExclusive;
  };

  for (let index = 1; index < lines.length; index += 1) {
    if (boundaryPattern.test(lines[index]) && index - start >= 8) {
      pushBlock(index);
    }
  }
  pushBlock(lines.length);

  return blocks.length > 0 ? blocks : [{
    type: 'code',
    text: content,
    sectionTitle: fallbackSectionTitle,
    sectionPath: fallbackSectionTitle,
    language,
    startLine: 1,
    endLine: Math.max(1, lines.length),
  }];
};

const splitLargeTableBlock = (content: string, chunkChars: number, overlapChars: number) => {
  const lines = content.split('\n');
  const separatorIndex = lines.findIndex(isMarkdownTableSeparator);
  if (separatorIndex < 1) {
    return splitTextByCharacterWindow(content, chunkChars, overlapChars);
  }

  const headerLines = lines.slice(0, separatorIndex + 1);
  const bodyLines = lines.slice(separatorIndex + 1).filter(line => line.trim());
  const headerText = headerLines.join('\n');
  if (headerText.length >= chunkChars) {
    return splitTextByCharacterWindow(content, chunkChars, overlapChars);
  }

  const chunks: string[] = [];
  let currentLines = [...headerLines];
  let overlapRows: string[] = [];

  for (const row of bodyLines) {
    const candidateLines = [...currentLines, row];
    if (candidateLines.join('\n').length <= chunkChars) {
      currentLines = candidateLines;
      continue;
    }

    const chunk = currentLines.join('\n').trim();
    if (chunk && currentLines.length > headerLines.length) {
      chunks.push(chunk);
    }

    overlapRows = [];
    let overlapLength = 0;
    for (let rowIndex = currentLines.length - 1; rowIndex >= headerLines.length; rowIndex -= 1) {
      const overlapRow = currentLines[rowIndex];
      if (overlapLength + overlapRow.length > overlapChars) {
        break;
      }
      overlapRows.unshift(overlapRow);
      overlapLength += overlapRow.length + 1;
    }

    currentLines = [...headerLines, ...overlapRows, row];
    if (currentLines.join('\n').length > chunkChars) {
      currentLines = [...headerLines, row];
    }
  }

  const finalChunk = currentLines.join('\n').trim();
  if (finalChunk && currentLines.length > headerLines.length) {
    chunks.push(finalChunk);
  }

  return chunks.length > 0 ? chunks : splitTextByCharacterWindow(content, chunkChars, overlapChars);
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
      fileId: item.fileId,
      sectionTitle: item.sectionTitle,
      sectionPath: item.sectionPath,
      chunkType: item.chunkType,
      language: item.language,
      certainty: item._additional?.certainty,
      score: typeof score === 'number' && Number.isFinite(score) ? score : undefined,
      scoreLabel,
      chunkIndex: item.chunkIndex,
      chunkCount: item.chunkCount,
      startLine: item.startLine,
      endLine: item.endLine,
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
      item.sectionTitle,
      item.sectionPath,
      item.chunkType,
      item.language,
      item.content,
    ].filter(Boolean).join('\n').toLowerCase();

    const matchedTerms = terms.filter(term => searchableText.includes(term));
    const termFrequency = matchedTerms.reduce((total, term) => total + Math.min(countOccurrences(searchableText, term), 5), 0);
    const phraseMatches = phrases.reduce((total, phrase) => total + (searchableText.includes(phrase) ? 1 : 0), 0);
    const coverage = terms.length ? matchedTerms.length / terms.length : 0;
    const normalizedWeaviateScore = typeof item.score === 'number' ? Math.min(item.score, 10) / 10 : 0;
    const normalizedCertainty = typeof item.certainty === 'number' ? item.certainty : 0;
    const filePathBoost = item.filePath && terms.some(term => item.filePath?.toLowerCase().includes(term)) ? 0.4 : 0;
    const sectionBoost = item.sectionPath && terms.some(term => item.sectionPath?.toLowerCase().includes(term)) ? 0.4 : 0;

    return {
      ...item,
      rerankScore: (
        phraseMatches * 3
        + coverage * 2
        + Math.min(termFrequency, 10) * 0.2
        + normalizedWeaviateScore
        + normalizedCertainty
        + filePathBoost
        + sectionBoost
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

const weaviateContextFields = [
  'content',
  'fileName',
  'filePath',
  'fileId',
  'sectionTitle',
  'sectionPath',
  'chunkType',
  'language',
  'startLine',
  'endLine',
  'chunkIndex',
  'chunkCount',
  '_additional { id score }',
].join(' ');

const expandWeaviateResultNeighbors = async (
  items: WeaviateContextItem[],
  className: string,
  query: string,
  snippetLength: number,
): Promise<WeaviateContextItem[]> => {
  const expanded = await Promise.all(items.map(async (item) => {
    if (!item.filePath || typeof item.chunkIndex !== 'number') {
      return item;
    }

    try {
      const result = await weaviateClient.graphql
        .get()
        .withClassName(className)
        .withFields(weaviateContextFields)
        .withWhere({
          operator: 'And',
          operands: [
            {
              path: ['filePath'],
              operator: 'Equal',
              valueText: item.filePath,
            },
            {
              path: ['chunkIndex'],
              operator: 'GreaterThanEqual',
              valueInt: Math.max(0, item.chunkIndex - 1),
            },
            {
              path: ['chunkIndex'],
              operator: 'LessThanEqual',
              valueInt: item.chunkIndex + 1,
            },
          ],
        })
        .withLimit(3)
        .do();

      const neighbors = (result?.data?.Get?.[className] || [])
        .filter((neighbor: any) => typeof neighbor.content === 'string' && typeof neighbor.chunkIndex === 'number')
        .sort((left: any, right: any) => left.chunkIndex - right.chunkIndex);

      if (neighbors.length <= 1) {
        return item;
      }

      return {
        ...item,
        content: neighbors.map((neighbor: any) => {
          const label = neighbor.chunkIndex === item.chunkIndex ? 'Matched chunk' : 'Neighbor chunk';
          const lines = typeof neighbor.startLine === 'number' && typeof neighbor.endLine === 'number'
            ? `, lines ${neighbor.startLine}-${neighbor.endLine}`
            : '';
          return `${label} ${neighbor.chunkIndex + 1}/${neighbor.chunkCount || item.chunkCount || '?'}${lines}\n${extractRelevantSnippet(neighbor.content.trim(), query, snippetLength)}`;
        }).join('\n\n'),
      };
    } catch (error) {
      console.warn(`Weaviate neighbor lookup failed for '${className}': ${errorMessage(error)}`);
      return item;
    }
  }));

  return expanded;
};

const searchWeaviateContext = async (query: string, className: string, limit: number): Promise<WeaviateContextItem[]> => {
  try {
    const exists = await weaviateClient.schema.exists(className);
    if (!exists) {
      console.warn(`Weaviate collection '${className}' does not exist; sending prompt without retrieved context.`);
      return [];
    }
    await ensureFileCollectionProperties(className);

    const snippetLength = Math.max(300, Math.min(WEAVIATE_SEARCH_SNIPPET_CHARS, Math.floor(WEAVIATE_CONTEXT_CHARS / Math.max(1, limit))));
    const candidateLimit = Math.max(limit, Math.min(WEAVIATE_SEARCH_MAX_CANDIDATES, Math.ceil(limit * Math.max(1, WEAVIATE_RERANK_CANDIDATE_MULTIPLIER))));
    const searchableProperties = ['content^3', 'sectionTitle^2', 'sectionPath^2', 'chunkType', 'language', 'fileName', 'filePath'];
    const searchMode = ['hybrid', 'keyword', 'both'].includes(WEAVIATE_SEARCH_MODE) ? WEAVIATE_SEARCH_MODE : 'hybrid';
    const hybridPromise = searchMode === 'keyword'
      ? Promise.resolve({ data: { Get: { [className]: [] } } })
      : weaviateClient.graphql
        .get()
        .withClassName(className)
        .withFields(weaviateContextFields)
        .withHybrid({ query, alpha: WEAVIATE_HYBRID_ALPHA, properties: searchableProperties })
        .withLimit(candidateLimit)
        .do();
    const keywordPromise = searchMode === 'hybrid'
      ? Promise.resolve({ data: { Get: { [className]: [] } } })
      : weaviateClient.graphql
        .get()
        .withClassName(className)
        .withFields(weaviateContextFields)
        .withBm25({ query, properties: searchableProperties })
        .withLimit(candidateLimit)
        .do();
    const [hybridResult, keywordResult] = await Promise.allSettled([hybridPromise, keywordPromise]);

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

    const ranked = rerankWeaviateResults(query, mergeWeaviateResults(hybridMatches, keywordMatches), limit);
    return expandWeaviateResultNeighbors(ranked, className, query, snippetLength);
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
    const section = item.sectionPath ? `, section ${item.sectionPath}` : '';
    const chunkType = item.chunkType ? `, type ${item.chunkType}` : '';
    const lines = typeof item.startLine === 'number' && typeof item.endLine === 'number'
      ? `, lines ${item.startLine}-${item.endLine}`
      : '';
    const source = `Source: ${sourceName}${chunk}${section}${chunkType}${lines}`;
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
      'When you use retrieved context, cite sources inline like [1]. Do not add a "Sources", "References", or bibliography section at the end of the answer.',
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
  keepAliveTimer?: ReturnType<typeof setInterval>;
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
  if (activeStream.keepAliveTimer) {
    clearInterval(activeStream.keepAliveTimer);
    activeStream.keepAliveTimer = undefined;
  }
  if (!activeStream.abortController.signal.aborted) {
    activeStream.abortController.abort();
  }
  activeStream.responseStream?.destroy?.(new Error(reason));
  ws.activeOllamaStream = undefined;
};

const clearStreamKeepAlive = (activeStream: ActiveOllamaStream) => {
  if (activeStream.keepAliveTimer) {
    clearInterval(activeStream.keepAliveTimer);
    activeStream.keepAliveTimer = undefined;
  }
};

const startWebSocketHeartbeat = () => {
  if (!Number.isFinite(WS_HEARTBEAT_MS) || WS_HEARTBEAT_MS <= 0) {
    return;
  }

  const timer = setInterval(() => {
    wss.clients.forEach((ws: any) => {
      if (ws.isAlive === false) {
        console.warn('WebSocket heartbeat missed; terminating stale client.');
        stopActiveStream(ws, 'WebSocket heartbeat missed');
        ws.terminate();
        return;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch (error) {
        console.warn('WebSocket heartbeat ping failed:', errorMessage(error));
      }
    });
  }, WS_HEARTBEAT_MS);

  wss.on('close', () => clearInterval(timer));
};

// Store active WebSocket connections
const clients = new Set();

// WebSocket server
wss.on('connection', (ws: any, req: any) => {
  console.log('✅ WebSocket client connected');
  console.log('   Client address:', req.socket.remoteAddress);
  console.log('   Total clients:', wss.clients.size);
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (message: any) => {
    try {
      ws.isAlive = true;
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
        recordAskedQuestion(text).catch((error) => {
          console.error('Question analytics error:', errorMessage(error));
        });

        stopActiveStream(ws, 'Superseded by a new request');
        const activeStream: ActiveOllamaStream = {
          abortController: new AbortController(),
          stopped: false,
        };
        ws.activeOllamaStream = activeStream;
        activeStream.keepAliveTimer = setInterval(() => {
          if (activeStream.stopped || ws.readyState !== WS_OPEN) {
            clearStreamKeepAlive(activeStream);
            return;
          }

          safeWsSend(ws, JSON.stringify({
            type: 'keepalive',
            payload: { timestamp: Date.now() },
          }));
        }, 15000);

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
                  sectionTitle: item.sectionTitle,
                  sectionPath: item.sectionPath,
                  chunkType: item.chunkType,
                  language: item.language,
                  startLine: item.startLine,
                  endLine: item.endLine,
                  chunkIndex: item.chunkIndex,
                  chunkCount: item.chunkCount,
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
            clearStreamKeepAlive(activeStream);
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
            clearStreamKeepAlive(activeStream);
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
          clearStreamKeepAlive(activeStream);
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

startWebSocketHeartbeat();

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL_NAME });
});

app.get('/api/chats', async (req, res) => {
  try {
    await ensureDatabase();
    const result = await postgresPool.query(`
      SELECT id, title, model, messages, created_at, updated_at
      FROM saved_chats
      ORDER BY updated_at DESC
      LIMIT 100;
    `);
    res.json({ chats: result.rows.map(toSavedChat) });
  } catch (error) {
    console.error('Saved chat list error:', errorMessage(error));
    res.status(500).json({ error: `Failed to load saved chats: ${errorMessage(error)}` });
  }
});

app.post('/api/chats', async (req, res) => {
  try {
    const messages = validateChatMessages(req.body?.messages);
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.replace(/\s+/g, ' ').trim()
      : 'Untitled chat';
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const chat = await upsertSavedChat({
      id: req.body?.id,
      title,
      model,
      messages,
    });
    res.json({ chat });
  } catch (error) {
    console.error('Saved chat write error:', errorMessage(error));
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.put('/api/chats/:id', async (req, res) => {
  try {
    const messages = validateChatMessages(req.body?.messages);
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.replace(/\s+/g, ' ').trim()
      : 'Untitled chat';
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const chat = await upsertSavedChat({
      id: req.params.id,
      title,
      model,
      messages,
    });
    res.json({ chat });
  } catch (error) {
    console.error('Saved chat update error:', errorMessage(error));
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.patch('/api/chats/:id', async (req, res) => {
  try {
    await ensureDatabase();
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.replace(/\s+/g, ' ').trim()
      : '';
    if (!title) {
      res.status(400).json({ error: 'A chat title is required.' });
      return;
    }

    const result = await postgresPool.query(
      `
        UPDATE saved_chats
        SET title = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, title, model, messages, created_at, updated_at;
      `,
      [req.params.id, title]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Saved chat not found.' });
      return;
    }
    res.json({ chat: toSavedChat(result.rows[0]) });
  } catch (error) {
    console.error('Saved chat rename error:', errorMessage(error));
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.delete('/api/chats/:id', async (req, res) => {
  try {
    await ensureDatabase();
    const result = await postgresPool.query('DELETE FROM saved_chats WHERE id = $1 RETURNING id;', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Saved chat not found.' });
      return;
    }
    res.json({ deleted: req.params.id });
  } catch (error) {
    console.error('Saved chat delete error:', errorMessage(error));
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get('/api/questions/top', async (req, res) => {
  try {
    await ensureDatabase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const result = await postgresPool.query(
      `
        SELECT display_question, ask_count, first_asked_at, last_asked_at
        FROM top_asked_questions
        ORDER BY ask_count DESC, last_asked_at DESC
        LIMIT $1;
      `,
      [limit]
    );
    res.json({
      questions: result.rows.map(row => ({
        question: row.display_question,
        count: row.ask_count,
        firstAskedAt: row.first_asked_at,
        lastAskedAt: row.last_asked_at,
      })),
    });
  } catch (error) {
    console.error('Top questions error:', errorMessage(error));
    res.status(500).json({ error: `Failed to load top questions: ${errorMessage(error)}` });
  }
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

app.post('/api/chat', trackAskedQuestionMiddleware, async (req, res) => {
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
          sectionTitle: item.sectionTitle,
          sectionPath: item.sectionPath,
          chunkType: item.chunkType,
          language: item.language,
          startLine: item.startLine,
          endLine: item.endLine,
          chunkIndex: item.chunkIndex,
          chunkCount: item.chunkCount,
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
  const heartbeat = startJsonHeartbeat(res);
  try {
    const className = normalizeWeaviateClassName(req.body?.className);
    const files = validateUploadedFiles(req.body?.files);
    const requestedStartChunkIndex = Math.max(0, Math.floor(Number(req.body?.startChunkIndex || 0)));
    const maxChunksPerRequest = Math.max(1, Math.floor(WEAVIATE_UPLOAD_MAX_CHUNKS_PER_REQUEST));
    if (requestedStartChunkIndex > 0 && files.length !== 1) {
      throw new Error('Chunked Weaviate upload continuation must include exactly one file.');
    }
    await ensureFileCollection(className);

    const uploadedAt = new Date().toISOString();
    const uploaded = [];
    const skippedDuplicates = [];

    for (const file of files) {
      const startChunkIndex = files.length === 1 ? requestedStartChunkIndex : 0;
      if (startChunkIndex === 0) {
        const existingFile = await findExistingFileByPath(className, file.path);
        if (existingFile) {
          const chunkIds = await findFileChunkIdsByPath(className, file.path);
          const expectedChunkCount = typeof existingFile.chunkCount === 'number' ? existingFile.chunkCount : 1;
          if (chunkIds.length < expectedChunkCount) {
            await deleteFileChunksByPath(className, file.path);
          } else {
            skippedDuplicates.push({
              id: existingFile._additional?.id,
              fileName: file.name,
              filePath: file.path,
              reason: 'already exists',
            });
            continue;
          }
        }
      } else {
        const chunkIds = await findFileChunkIdsByPath(className, file.path);
        if (chunkIds.length < startChunkIndex) {
          throw new Error(`Upload continuation for "${file.path}" is missing earlier chunks. Restart the upload.`);
        }
      }

      const chunks = splitContentIntoChunks(file.content, file.path, file.type);
      const clampedStartChunkIndex = Math.min(startChunkIndex, chunks.length);
      const endChunkIndex = Math.min(chunks.length, clampedStartChunkIndex + maxChunksPerRequest);
      const fileId = createFileId(file.path);
      let firstChunkId = '';

      try {
        for (let chunkIndex = clampedStartChunkIndex; chunkIndex < endChunkIndex; chunkIndex += 1) {
          const chunk = chunks[chunkIndex];
          const result = await createWeaviateChunkWithRetry(className, {
            content: chunk.content,
            fileName: file.name,
            filePath: file.path,
            fileId,
            chunkIndex,
            chunkCount: chunks.length,
            chunkType: chunk.chunkType,
            sectionTitle: chunk.sectionTitle,
            sectionPath: chunk.sectionPath,
            language: chunk.language,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            mimeType: file.type,
            size: file.size,
            uploadedAt,
          });

          if (!firstChunkId && typeof result.id === 'string') {
            firstChunkId = result.id;
          }

          if (WEAVIATE_UPLOAD_CHUNK_DELAY_MS > 0 && chunkIndex < endChunkIndex - 1) {
            await sleep(WEAVIATE_UPLOAD_CHUNK_DELAY_MS);
          }
        }
      } catch (error) {
        const deletedCount = await deleteFileChunksByPath(className, file.path);
        if (deletedCount > 0) {
          console.warn(`Removed ${deletedCount} partial Weaviate chunk(s) for ${file.path} after upload failure.`);
        }
        throw error;
      }

      const complete = endChunkIndex >= chunks.length;
      const completedFile = complete ? await findExistingFileByPath(className, file.path) : undefined;
      uploaded.push({
        id: firstChunkId || completedFile?._additional?.id || '',
        fileName: file.name,
        filePath: file.path,
        size: file.size,
        chunkCount: chunks.length,
        processedChunkCount: endChunkIndex - clampedStartChunkIndex,
        nextChunkIndex: complete ? null : endChunkIndex,
        complete,
      });
    }

    heartbeat.writeJson(200, {
      className,
      uploaded,
      count: uploaded.length,
      skippedDuplicates,
      skippedDuplicateCount: skippedDuplicates.length,
    });
  } catch (error) {
    console.error('Weaviate upload error:', errorMessage(error));
    if (isConnectionRefused(error)) {
      heartbeat.writeJson(res.headersSent ? 200 : 503, { error: weaviateUnavailableMessage() });
      return;
    }
    if (isTransientWeaviateVectorizerError(error)) {
      heartbeat.writeJson(res.headersSent ? 200 : 502, {
        error: `Weaviate timed out while embedding upload chunks. Retry after the t2v-transformers container is healthy, or reduce WEAVIATE_UPLOAD_CHUNK_CHARS / increase WEAVIATE_UPLOAD_CHUNK_DELAY_MS. Details: ${errorMessage(error)}`,
      });
      return;
    }
    heartbeat.writeJson(res.headersSent ? 200 : 400, { error: errorMessage(error) });
  } finally {
    heartbeat.stop();
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
            description: 'Search documents in a Weaviate collection using hybrid vector and keyword search',
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
            .withFields('content _additional { id score }')
            .withHybrid({ query: args.query, alpha: WEAVIATE_HYBRID_ALPHA, properties: ['content'] })
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
