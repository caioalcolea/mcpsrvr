import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  port: process.env.PORT || 3010,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
  authToken: process.env.MCP_AUTH_TOKEN || null,
  serviceName: process.env.SERVICE_NAME || 'uai-salgados-mcp',
  version: '3.0.0',
  domain: process.env.DOMAIN || 'mcp.talkhub.me',
  cardapioId: process.env.CARDAPIO_ID || 'd38f4f7c-6223-4d6b-989f-8a62754e3d2a'
};

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level}] ${message} ${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

logger.info('🚀 Iniciando UAI Salgados MCP Server', { version: config.version });

let supabase;
try {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Configurações do Supabase não encontradas');
  }

  supabase = createClient(config.supabaseUrl, config.serviceKey || config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  
  logger.info('✅ Supabase client inicializado', { url: config.supabaseUrl });
} catch (error) {
  logger.error('❌ Erro ao inicializar Supabase', { error: error.message });
  process.exit(1);
}

class MCPServer {
  constructor() {
    this.protocolVersion = '2025-03-26';
    this.serverInfo = {
      name: config.serviceName,
      version: config.version,
      vendor: 'UAI Salgados Moema',
      description: 'Servidor MCP para consulta de produtos da UAI Salgados'
    };
    this.capabilities = { tools: {} };
  }

  formatResponse(id, result, error = null) {
    if (error) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
    }
    return { jsonrpc: '2.0', id, result };
  }

  formatSSEMessage(data) {
    return 'data: ' + JSON.stringify(data) + '\n\n';
  }
}

const mcp = new MCPServer();

function formatPrice(price) {
  const num = parseFloat(price);
  return isNaN(num) ? 0 : num;
}

function formatPriceDisplay(price) {
  const num = formatPrice(price);
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

function sanitizeString(str) {
  return str ? String(str).trim() : '';
}

const tools = {
  buscar_produtos: {
    definition: {
      name: 'buscar_produtos',
      description: 'Busca produtos no cardápio da UAI Salgados por nome, descrição ou categoria',
      inputSchema: {
        type: 'object',
        properties: {
          termo_busca: { type: 'string', description: 'Termo para buscar (ex: coxinha, kibe, frango)' },
          categoria_id: { type: 'string', description: 'ID da categoria para filtrar (opcional)' },
          apenas_disponiveis: { type: 'boolean', description: 'Buscar apenas produtos disponíveis', default: true },
          limite: { type: 'integer', description: 'Número máximo de produtos (1-50)', minimum: 1, maximum: 50, default: 10 }
        },
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const startTime = Date.now();
      logger.debug('🔍 Buscando produtos', { args });
      
      try {
        const termo = sanitizeString(args.termo_busca || '').toLowerCase();
        const categoriaId = sanitizeString(args.categoria_id || '');
        const apenasDisponiveis = args.apenas_disponiveis !== false;
        const limite = Math.min(Math.max(parseInt(args.limite) || 10, 1), 50);

        let query = supabase.from('produtos').select(`
          id, nome, descricao, preco, imagem, disponivel, ordem, categoria_id
        `);

        if (apenasDisponiveis) {
          query = query.eq('disponivel', true);
        }

        if (categoriaId) {
          query = query.eq('categoria_id', categoriaId);
        }

        if (termo) {
          query = query.ilike('nome', `%${termo}%`);
        }

        const { data: produtos, error } = await query
          .order('ordem', { ascending: true })
          .order('nome', { ascending: true })
          .limit(limite);

        if (error) {
          throw new Error(`Erro na busca: ${error.message}`);
        }

        if (!produtos || produtos.length === 0) {
          return {
            sucesso: true,
            produtos: [],
            total: 0,
            mensagem: 'Nenhum produto encontrado',
            cardapio_completo: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}`,
            tempo_execucao: Date.now() - startTime + 'ms'
          };
        }

        const categoriaIds = [...new Set(produtos.map(p => p.categoria_id).filter(id => id))];
        let categorias = [];

        if (categoriaIds.length > 0) {
          const { data: categoriasData } = await supabase
            .from('categorias')
            .select('id, nome')
            .in('id', categoriaIds);
          categorias = categoriasData || [];
        }

        const produtosFormatados = produtos.map(produto => {
          const categoria = categorias.find(c => c.id === produto.categoria_id);
          return {
            id: produto.id,
            nome: sanitizeString(produto.nome),
            descricao: sanitizeString(produto.descricao),
            preco: formatPrice(produto.preco),
            preco_formatado: formatPriceDisplay(produto.preco),
            imagem: sanitizeString(produto.imagem),
            disponivel: produto.disponivel,
            categoria: categoria ? {
              id: categoria.id,
              nome: sanitizeString(categoria.nome)
            } : null,
            url_compra: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}#produto-${produto.id}`
          };
        });

        logger.info('✅ Busca concluída', { 
          produtos_encontrados: produtosFormatados.length,
          tempo: Date.now() - startTime + 'ms'
        });

        return {
          sucesso: true,
          produtos: produtosFormatados,
          total: produtosFormatados.length,
          mensagem: `Encontrados ${produtosFormatados.length} produto(s)`,
          cardapio_completo: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}`,
          tempo_execucao: Date.now() - startTime + 'ms'
        };

      } catch (error) {
        logger.error('💥 Erro em buscar_produtos', { error: error.message });
        return {
          sucesso: false,
          produtos: [],
          total: 0,
          erro: error.message,
          mensagem: 'Erro ao buscar produtos',
          cardapio_completo: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}`,
          tempo_execucao: Date.now() - startTime + 'ms'
        };
      }
    }
  },

  listar_categorias: {
    definition: {
      name: 'listar_categorias',
      description: 'Lista todas as categorias de produtos disponíveis',
      inputSchema: {
        type: 'object',
        properties: {
          incluir_contagem: { type: 'boolean', description: 'Incluir contagem de produtos por categoria', default: true }
        },
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const startTime = Date.now();
      logger.debug('📋 Listando categorias', { args });
      
      try {
        const { data: categorias, error } = await supabase
          .from('categorias')
          .select('id, nome, ordem')
          .eq('cardapio_id', config.cardapioId)
          .order('ordem', { ascending: true });

        if (error) {
          throw new Error(`Erro ao buscar categorias: ${error.message}`);
        }

        let categoriasFormatadas = (categorias || []).map(cat => ({
          id: cat.id,
          nome: sanitizeString(cat.nome),
          ordem: cat.ordem,
          produtos_count: 0
        }));

        if (args.incluir_contagem !== false && categorias.length > 0) {
          try {
            const { data: produtos } = await supabase
              .from('produtos')
              .select('categoria_id')
              .eq('disponivel', true)
              .in('categoria_id', categorias.map(c => c.id));

            const contagem = {};
            produtos?.forEach(p => {
              contagem[p.categoria_id] = (contagem[p.categoria_id] || 0) + 1;
            });

            categoriasFormatadas = categoriasFormatadas.map(cat => ({
              ...cat,
              produtos_count: contagem[cat.id] || 0
            }));
          } catch (countError) {
            logger.warn('⚠️ Erro ao contar produtos', { error: countError.message });
          }
        }

        return {
          sucesso: true,
          categorias: categoriasFormatadas,
          total: categoriasFormatadas.length,
          tempo_execucao: Date.now() - startTime + 'ms'
        };

      } catch (error) {
        logger.error('💥 Erro em listar_categorias', { error: error.message });
        return {
          sucesso: false,
          categorias: [],
          total: 0,
          erro: error.message,
          tempo_execucao: Date.now() - startTime + 'ms'
        };
      }
    }
  },

  informacoes_loja: {
    definition: {
      name: 'informacoes_loja',
      description: 'Obtém informações da loja UAI Salgados',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    handler: async () => {
      return {
        sucesso: true,
        loja: {
          nome: 'UAI Salgados Moema',
          endereco: 'Rua Juquis, 258 - Moema/SP',
          referencia: 'Próximo à estação Eucalipto do Metrô',
          telefone: '11 94183-7616',
          whatsapp: 'https://wa.me/5511941837616'
        },
        horarios: {
          semana: 'Segunda a Sábado: 09h às 20h',
          domingo: 'Domingos e Feriados: 10h às 18h'
        },
        atendimento: {
          area_cobertura: 'São Paulo (capital) + ABC Paulista',
          cidades_abc: ['São Bernardo', 'Santo André', 'São Caetano', 'Diadema']
        },
        produtos: {
          variedade: 'Mais de 100 tipos de salgados congelados',
          preparo: 'Fácil preparo: direto do freezer ao forno/airfryer',
          porcao_sugerida: '12 a 20 mini salgados por pessoa'
        },
        cardapio_online: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}`
      };
    }
  }
};

mcp.capabilities.tools = Object.fromEntries(
  Object.entries(tools).map(([name, tool]) => [name, tool.definition])
);

logger.info('🛠️ Ferramentas registradas', { total: Object.keys(tools).length });

const app = express();

app.use(cors({ 
  origin: true, 
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json({ limit: '1mb' }));

if (config.authToken) {
  app.use((req, res, next) => {
    const publicPaths = ['/health', '/.well-known/mcp', '/test'];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    
    const authHeader = req.get('authorization') || '';
    if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === config.authToken) {
      return next();
    }
    
    return res.status(401).json({ error: 'Unauthorized' });
  });
}

app.get('/health', async (req, res) => {
  try {
    const { data, error } = await supabase.from('produtos').select('id').limit(1);
    if (error) throw error;

    res.json({
      status: 'healthy',
      service: config.serviceName,
      version: config.version,
      timestamp: new Date().toISOString(),
      database: { status: 'connected', supabase_url: config.supabaseUrl },
      tools_available: Object.keys(tools).length
    });
  } catch (err) {
    logger.error('Health check failed', { error: err.message });
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/test', async (req, res) => {
  try {
    const testResult = await tools.buscar_produtos.handler({ termo_busca: 'coxinha', limite: 3 });

    res.json({
      status: 'test_success',
      timestamp: new Date().toISOString(),
      test_busca_produtos: {
        sucesso: testResult.sucesso,
        total_encontrados: testResult.total,
        tempo: testResult.tempo_execucao
      },
      config: {
        supabase_url: config.supabaseUrl,
        cardapio_id: config.cardapioId,
        auth_enabled: !!config.authToken
      }
    });
  } catch (err) {
    res.json({ status: 'test_failed', error: err.message });
  }
});

app.get('/.well-known/mcp', (req, res) => {
  res.json({
    protocol_version: mcp.protocolVersion,
    server_info: mcp.serverInfo,
    capabilities: mcp.capabilities,
    endpoints: {
      mcp: `https://${config.domain}/`,
      health: `https://${config.domain}/health`,
      test: `https://${config.domain}/test`
    },
    tools_available: Object.keys(tools),
    authentication: {
      required: !!config.authToken,
      type: config.authToken ? 'bearer' : 'none'
    }
  });
});

app.get('/', (req, res) => {
  logger.info('📡 Conexão SSE MCP estabelecida');
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.write(':connected\n\n');
  
  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {
      protocolVersion: mcp.protocolVersion,
      capabilities: mcp.capabilities,
      serverInfo: mcp.serverInfo,
      instructions: 'Servidor MCP da UAI Salgados. Use as ferramentas para buscar produtos e informações.'
    }
  };
  
  res.write(mcp.formatSSEMessage(initMessage));
  
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(heartbeat);
    logger.info('📡 Conexão SSE fechada');
  });
});

app.post('/', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  
  if (jsonrpc !== '2.0') {
    return res.json(mcp.formatResponse(id, null, { message: 'Invalid JSON-RPC version' }));
  }
  
  try {
    switch (method) {
      case 'initialize':
        res.json(mcp.formatResponse(id, {
          protocolVersion: mcp.protocolVersion,
          capabilities: mcp.capabilities,
          serverInfo: mcp.serverInfo,
          instructions: 'Servidor MCP da UAI Salgados. Use buscar_produtos para encontrar produtos específicos.'
        }));
        break;
        
      case 'tools/list':
        res.json(mcp.formatResponse(id, {
          tools: Object.values(tools).map(tool => tool.definition)
        }));
        break;
        
      case 'tools/call':
        const { name, arguments: toolArgs } = params || {};
        
        if (!tools[name]) {
          return res.json(mcp.formatResponse(id, null, { message: `Tool not found: ${name}` }));
        }
        
        try {
          logger.info(`🔧 Executando: ${name}`, { args: toolArgs });
          const result = await tools[name].handler(toolArgs || {});
          res.json(mcp.formatResponse(id, result));
        } catch (toolError) {
          logger.error(`💥 Erro na ferramenta ${name}`, { error: toolError.message });
          res.json(mcp.formatResponse(id, null, { message: toolError.message }));
        }
        break;
        
      default:
        res.json(mcp.formatResponse(id, null, { message: `Method not found: ${method}` }));
    }
  } catch (error) {
    logger.error('💥 Erro no JSON-RPC', { error: error.message });
    res.json(mcp.formatResponse(id, null, { message: 'Internal server error' }));
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    available_endpoints: ['/', '/health', '/test', '/.well-known/mcp']
  });
});

const server = app.listen(config.port, () => {
  logger.info('🚀 UAI Salgados MCP Server ONLINE', {
    port: config.port,
    version: config.version,
    domain: config.domain,
    tools: Object.keys(tools).length,
    auth_enabled: !!config.authToken,
    endpoints: {
      mcp: `https://${config.domain}/`,
      health: `https://${config.domain}/health`,
      test: `https://${config.domain}/test`,
      cardapio: `https://talkhub.me/cardapios/cardapio_uai/cardapio-cliente.html?id=${config.cardapioId}`
    }
  });
  
  setTimeout(async () => {
    try {
      logger.info('🧪 Executando teste inicial...');
      const testResult = await tools.buscar_produtos.handler({ termo_busca: 'coxinha', limite: 3 });
      
      if (testResult.sucesso) {
        logger.info('✅ Sistema validado e funcionando!', { produtos_encontrados: testResult.total });
      } else {
        logger.warn('⚠️ Teste inicial falhou', { erro: testResult.erro });
      }
    } catch (error) {
      logger.error('❌ Erro no teste inicial', { error: error.message });
    }
  }, 2000);
});

process.on('SIGTERM', () => {
  logger.info('🛑 SIGTERM received, shutting down...');
  server.close(() => {
    logger.info('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('🛑 SIGINT received, shutting down...');
  server.close(() => {
    logger.info('✅ Server closed');
    process.exit(0);
  });
});