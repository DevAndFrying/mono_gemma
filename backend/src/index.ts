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

const truncateText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
};

const searchWeaviateContext = async (query: string, className: string, limit: number): Promise<WeaviateContextItem[]> => {
  try {
    const exists = await weaviateClient.schema.exists(className);
    if (!exists) {
      console.warn(`Weaviate collection '${className}' does not exist; sending prompt without retrieved context.`);
      return [];
    }

    const result = await weaviateClient.graphql
      .get()
      .withClassName(className)
      .withFields('content fileName filePath _additional { id certainty }')
      .withNearText({ concepts: [query] })
      .withLimit(limit)
      .do();

    const matches = result?.data?.Get?.[className] || [];
    return matches
      .filter((item: any) => typeof item.content === 'string' && item.content.trim())
      .map((item: any) => ({
        id: item._additional?.id,
        className,
        content: item.content.trim(),
        fileName: item.filePath || item.fileName,
        filePath: item.filePath,
        certainty: item._additional?.certainty,
        sourceUrl: item._additional?.id
          ? `/api/weaviate/source/${encodeURIComponent(className)}/${encodeURIComponent(item._additional.id)}`
          : undefined,
      }));
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
    .sort((left, right) => (right.certainty || 0) - (left.certainty || 0))
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
    const source = `Source: ${sourceName}`;
    const score = typeof item.certainty === 'number' ? `, certainty ${item.certainty.toFixed(3)}` : '';
    const link = item.sourceUrl ? `\nLink: ${item.sourceUrl}` : '';
    return `[${index + 1}] ${source}${score}${link}\n${truncateText(item.content, charsPerItem)}`;
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

      if (type === 'message') {
        const { text, className, classNames, model, useWeaviateContext = true } = payload;
        const generationOptions = normalizeGenerationOptions(payload);
        const contextOptions = normalizeContextOptions(payload);
        console.log('👤 User message:', text);

        try {
          const resolvedModel = await resolveOllamaModel(model);
          const {
            prompt,
            classNames: contextClassNames,
            contextCount,
            contextItems,
          } = await buildPromptWithWeaviateContext(text, classNames, useWeaviateContext, className, contextOptions);

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
              timeout: 300000 // 5 minute timeout
            }
          );

          console.log('🟢 Response received from Ollama, status:', response.status);
          if (resolvedModel.fallback) {
            ws.send(JSON.stringify({
              type: 'model',
              payload: {
                model: resolvedModel.model,
                requestedModel: resolvedModel.requestedModel,
                fallback: true,
              },
            }));
          }
          if (contextItems.length > 0) {
            ws.send(JSON.stringify({
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
              
              // Capture thinking context if present
              if (json.thinking) {
                thinkingContext += json.thinking;
                const thinkingMsg = JSON.stringify({
                  type: 'thinking',
                  payload: { text: json.thinking },
                });
                console.log('   → Sending thinking:', json.thinking.substring(0, 30));
                ws.send(thinkingMsg);
              }
              
              // Capture response text - Ollama sends fresh text each chunk
              if (json.response) {
                const streamMsg = JSON.stringify({
                  type: 'stream',
                  payload: { text: json.response },
                });
                console.log('   → Sending stream:', json.response.substring(0, 30));
                ws.send(streamMsg);
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
            if (isStreamComplete) return;
            
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
            if (streamBuffer.trim() && !isStreamComplete) {
              handleOllamaLine(streamBuffer, 0);
            }
            console.log('🔴 Stream ended after', chunkCount, 'chunks');
            const completeMsg = JSON.stringify({
              type: 'complete',
              payload: { text: '', thinking: thinkingContext },
            });
            console.log('   → Sending complete message');
            ws.send(completeMsg);
          });

          response.data.on('error', (error: Error) => {
            console.error('❌ Stream error:', error.message);
            ws.send(JSON.stringify({
              type: 'error',
              payload: { error: `Stream error: ${error.message}` },
            }));
          });
        } catch (streamError) {
          console.error('❌ Ollama request error:', ollamaErrorMessage(streamError));
          console.error('   Stack:', errorStack(streamError));
          ws.send(JSON.stringify({
            type: 'error',
            payload: { error: `Connection error: ${ollamaErrorMessage(streamError)}` },
          }));
        }
      }
    } catch (error) {
      console.error('Error:', errorMessage(error));
      ws.send(JSON.stringify({
        type: 'error',
        payload: { error: errorMessage(error) },
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
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

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    res.send([`Source: ${filePath}`, '', content].join('\n'));
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
      .withFields('fileName filePath mimeType size uploadedAt _additional { id }')
      .withLimit(1000)
      .do();

    const files = (result?.data?.Get?.[className] || [])
      .map((file: any) => ({
        id: file._additional?.id,
        fileName: file.fileName,
        filePath: file.filePath || file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        uploadedAt: file.uploadedAt,
      }))
      .filter((file: any) => typeof file.id === 'string')
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

    await weaviateClient.data
      .deleter()
      .withClassName(className)
      .withId(id)
      .do();

    res.json({ deleted: id, className });
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

      const result = await weaviateClient.data.creator()
        .withClassName(className)
        .withProperties({
          content: file.content,
          fileName: file.name,
          filePath: file.path,
          mimeType: file.type,
          size: file.size,
          uploadedAt,
        })
        .do();

      uploaded.push({
        id: result.id,
        fileName: file.name,
        filePath: file.path,
        size: file.size,
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
