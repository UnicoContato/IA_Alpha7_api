const axios = require('axios');
const {
  buscarCandidatosCorrecaoTermo,
  buscarPrincipiosAtivosPorTermoFlexivel
} = require('../db/queries');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function extrairObjetoJSON(texto) {
  const conteudo = String(texto || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const inicio = conteudo.indexOf('{');
  const fim = conteudo.lastIndexOf('}');

  if (inicio === -1 || fim === -1 || fim < inicio) {
    throw new Error('IA pre-busca nao retornou JSON valido.');
  }

  return JSON.parse(conteudo.slice(inicio, fim + 1));
}

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/+.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deveTentarPreBuscaIA({ termoOriginal, termoBase }) {
  const texto = normalizarTexto(termoOriginal);
  const base = normalizarTexto(termoBase);

  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sua-chave-aqui') {
    return false;
  }

  if (!base || base.length < 4) {
    return false;
  }

  const tokens = base.split(' ').filter(Boolean);
  if (tokens.length > 3) {
    return false;
  }

  return texto.length <= 60;
}

async function normalizarBuscaComIA({ termoOriginal, termoBase, formaFarmaceutica, concentracoesBusca }) {
  if (!deveTentarPreBuscaIA({ termoOriginal, termoBase })) {
    return null;
  }

  const candidatos = await buscarCandidatosCorrecaoTermo(termoBase, 20);
  const principiosFlexiveis = await buscarPrincipiosAtivosPorTermoFlexivel([
    termoBase,
    String(termoBase || '').slice(0, 4),
    String(termoBase || '').slice(0, 5),
    String(termoBase || '').slice(0, 6)
  ], 20);
  const opcoes = [...new Set(
    [
      ...principiosFlexiveis.map(item => item.nome),
      ...candidatos.map(item => String(item?.texto_candidato || '').trim())
    ]
      .filter(Boolean)
  )].slice(0, 15);

  const prompt = `Analise um termo digitado por cliente de farmacia e normalize apenas o necessario para busca em ERP.

Regras:
- Corrija somente erro ortografico obvio de medicamento/produto.
- Nao invente produto.
- Nao recomende tratamento.
- Nao mude concentracao ou forma farmacêutica se ja estiverem claras.
- Se nao tiver alta confianca, mantenha o termo base original.
- Se houver candidatos, escolha preferencialmente um deles.
- Responda APENAS com JSON.

Entrada:
${JSON.stringify({
    termo_original: termoOriginal,
    termo_base_extraido: termoBase,
    forma_farmaceutica_extraida: formaFarmaceutica || null,
    concentracoes_extraidas: concentracoesBusca || [],
    candidatos_base: opcoes
  }, null, 2)}

Formato exato:
{"termo_corrigido":"...", "confianca":0.0, "justificativa_curta":"...", "manter_original":true}`;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Voce normaliza termos de busca de farmacia para ERP. Corrija apenas erro ortografico obvio e responda somente JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const json = extrairObjetoJSON(response.data?.choices?.[0]?.message?.content);
  const termoCorrigido = String(json?.termo_corrigido || '').trim();
  const confianca = Number(json?.confianca || 0);
  const manterOriginal = json?.manter_original === true;

  if (!termoCorrigido || !Number.isFinite(confianca)) {
    return null;
  }

  return {
    termo_corrigido: termoCorrigido,
    confianca,
    manter_original: manterOriginal,
    justificativa_curta: String(json?.justificativa_curta || '').trim()
  };
}

module.exports = {
  normalizarBuscaComIA
};
