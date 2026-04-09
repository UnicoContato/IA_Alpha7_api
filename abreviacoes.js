// abreviacoes.js — BUSCA INTELIGENTE COM RANKING DE RELEVÂNCIA

// 🔹 Sinônimos / abreviações curtas (EXPANSÃO CONTROLADA)
const sinonimos = {
    // =========================
    // Público / indicação
    // =========================
    adulto: ['adt', 'adulto'],
    pediatrico: ['ped', 'pediatrico'],
  
    // =========================
    // Vias / uso / contexto
    // =========================
    dermatologica: ['derm', 'dermatologica'],
    hospitalar: ['hosp', 'hospitalar'],
    inaladora: ['inal', 'inaladora'],
    injetavel: ['inj', 'injetavel', 'injecao'],
    nasal: ['nas', 'nasal'],
    oftalmologica: ['oft', 'oftalmologica'],
    sublingual: ['subl', 'sublingual'],
    vaginal: ['vag', 'vaginal'],
    retal: ['ret', 'retal'],
    oral: ['via oral'],
    topico: ['top', 'topico'],
    intravenoso: ['iv', 'intravenoso'],
    intramuscular: ['im', 'intramuscular'],
    subcutaneo: ['sc', 'subcutaneo'],
  
    // =========================
    // Formas farmacêuticas
    // =========================
    comprimido: ['cp', 'cpr', 'comprimido', 'comprimidos'],
    capsula: ['caps', 'cps', 'cap', 'capsula', 'capsulas'],
    dragea: ['drg', 'dragea', 'drageas'],
    creme: ['cr', 'creme', 'cremes'],
    pomada: ['pom', 'pomada'],
    gel: ['gel', 'gels'],
    unguento: ['ung', 'unguento'],
    xarope: ['xpe', 'xar', 'xarope'],
    solucao: ['sol', 'solucao'],
    suspensao: ['susp', 'suspensao'],
    elixir: ['elx', 'elixir'],
    granulado: ['gran', 'granulado'],
    efervescente: ['efv', 'efervescente'],
    mastigavel: ['mast', 'mastigavel'],
    revestido: ['rev', 'revestido', 'revestidos'],
    pastilha: ['past', 'pastilhas'],
    gotas: ['gts', 'gotas'],
    spray: ['spray', 'aer', 'aerossol'],
    colirio: ['col', 'colirio'],
    supositorio: ['supos', 'supositorio'],
    aplicador: ['aplic', 'aplicador'],
  
    // =========================
    // Embalagens / apresentações
    // =========================
    frasco: ['fr', 'frasco', 'frascos'],
    ampola: ['amp', 'ampola', 'ampolas'],
    cartela: ['cart', 'cartela', 'cartelas'],
    caixa: ['cx', 'caixa', 'caixas'],
    blister: ['bl', 'blister', 'blisters'],
    sache: ['sach', 'sache', 'saches'],
    bisnaga: ['bisn', 'bisnaga', 'bisnagas'],
    pacote: ['pct', 'pacote', 'pacotes'],
    flaconete: ['flac', 'flaconete'],
    envelope: ['env', 'envelope'],
    seringa: ['ser', 'seringa', 'seringas'],
    unidade: ['un', 'unidade', 'unidades'],
  
    // =========================
    // Tipos de medicamento
    // =========================
    generico: ['gen', 'generico'],
    referencia: ['ref', 'referencia'],
    similar: ['sim', 'similar'],
    etico: ['etico'],
    controlado: ['control', 'controlado'],
    tarjapreta: ['tarja preta'],
    tarjavermelha: ['tarja vermelha'],
    otc: ['isento de prescricao', 'sem receita'],
  
    // =========================
    // Higiene pessoal
    // =========================
    shampoo: ['sh', 'xampu', 'shampoo'],
    condicionador: ['cond', 'condicionador'],
    sabonete: ['sabon', 'sabonete'],
    sabonete_liquido: ['sabonliq', 'sabonete liquido'],
    escova_dente: ['escdente', 'escova de dente'],
    pasta_dente: ['pastadente', 'creme dental', 'pasta de dente'],
    enxaguante_bucal: ['enxaguante', 'enxaguatorio bucal'],
    desodorante: ['desod', 'desodorante'],
    hidratante: ['hidrat', 'hidratante'],
    protetor_solar: ['prot', 'protetor solar', 'filtro solar'],
  
    // =========================
    // Bebês / cuidados
    // =========================
    fralda: ['fralda', 'fraldas', 'frd'],
    lenco_umedecido: ['lenco', 'lencos umedecidos'],
    pomada_assadura: ['pomassadura', 'pomada para assadura'],
    mamadeira: ['mam', 'mamadeira'],
    chupeta: ['chup', 'chupeta'],
  
    // =========================
    // Saúde / consumo
    // =========================
    absorvente: ['abs', 'absorv', 'absorvente', 'absorvente higienico'],
    termometro: ['term', 'termometro'],
    teste_rapido: ['teste', 'teste rapido'],
    alcool: ['alcool', 'alcool 70'],
    algodao: ['algodao'],
    gaze: ['gaze'],
    agulha: ['agulha', 'agulhas'],
  
    // =========================
    // Quantificadores / símbolos
    // =========================
    com: ['c/', 'com'],
  
    // =========================
    // Unidades de medida
    // =========================
    centimetro: ['cm', 'centimetros'],
    grama: ['g', 'grama'],
    micrograma: ['mcg', 'micrograma'],
    miligrama: ['mg', 'miligrama', 'miligramas'],
    mililitro: ['ml', 'mililitro', 'mililitros'],
  };
  
  
  // 🔹 Palavras descartáveis (ruído)
const STOPWORDS = new Set([
    'de', 'da', 'do', 'dos', 'das',
    'para', 'com', 'sem',
    'ml', 'mg', 'g', 'kg', 'l', 'lt',
    'cx', 'und', 'un',
    'pct', 'kit'
  ]);

const aliasParaCanonico = Object.entries(sinonimos).reduce((acc, [canonico, aliases]) => {
    aliases.forEach(alias => {
      const normalizado = String(alias || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (normalizado) {
        acc[normalizado] = canonico;
      }
    });

    const canonicoNormalizado = String(canonico || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (canonicoNormalizado) {
      acc[canonicoNormalizado] = canonico;
    }

    return acc;
  }, {});
  
  // ============================================================
  // NORMALIZAÇÃO FORTE
  // ============================================================
  function normalizarTermoBusca(termo) {
    return termo
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // ============================================================
  // TOKENIZAÇÃO
  // ============================================================
  function tokenizar(termoNormalizado) {
    return termoNormalizado
      .split(' ')
      .filter(t =>
        t.length > 1 &&
        !STOPWORDS.has(t) &&
        !/^\d+$/.test(t) // remove números puros
      );
  }
  
  // ============================================================
  // EXPANSÃO CONTROLADA (SEM EXPLODIR)
  // ============================================================
function expandirTokens(tokens) {
  const resultado = new Set(tokens);
  
  tokens.forEach(token => {
      const canonico = sinonimos[token] ? token : aliasParaCanonico[token];

      if (canonico && sinonimos[canonico]) {
        resultado.add(canonico);
        sinonimos[canonico].forEach(s => resultado.add(s));
      }
  });
  
  return Array.from(resultado);
}
  
  // ============================================================
  // API PÚBLICA — mantém compatibilidade
  // ============================================================
  function expandirAbreviacoes(termo) {
    const normalizado = normalizarTermoBusca(termo);
    const tokens = tokenizar(normalizado);
    return expandirTokens(tokens);
  }
  
  // ============================================================
  // GERAÇÃO DE SQL COM RANKING DE RELEVÂNCIA (SOLUÇÃO!)
  // ============================================================
  function gerarCondicoesBuscaComRanking(tokens) {
    if (tokens.length === 0) {
      return {
        condicoes: '1=1',
        parametros: [],
        orderBy: 'p.descricao'
      };
    }
  
    const condicoes = [];
    const parametros = [];
    const caseStatements = [];
    let idx = 1;
  
    // Para cada token, criar condição OR
    tokens.forEach(token => {
      condicoes.push(`p.descricao ILIKE $${idx}`);
      parametros.push(`%${token}%`);
      
      // Score: +10 pontos por cada palavra que bate
      caseStatements.push(`CASE WHEN p.descricao ILIKE $${idx} THEN 10 ELSE 0 END`);
      
      idx++;
    });
  
    // Score adicional para match exato (boost de 100 pontos)
    const termoCompleto = tokens.join(' ');
    condicoes.push(`p.descricao ILIKE $${idx}`);
    parametros.push(`%${termoCompleto}%`);
    caseStatements.push(`CASE WHEN p.descricao ILIKE $${idx} THEN 100 ELSE 0 END`);
  
    // Construir ranking SQL
    const relevanciaSQL = `(${caseStatements.join(' + ')})`;
  
    return {
      condicoes: condicoes.join(' OR '),  // ✅ MUDOU DE AND PARA OR!
      parametros,
      relevanciaSQL,
      orderBy: `${relevanciaSQL} DESC, p.descricao`
    };
  }
  
  // ============================================================
  // VERSÃO ANTIGA (para compatibilidade)
  // ============================================================
  function gerarCondicoesBusca(tokens) {
    if (tokens.length === 0) {
      return {
        condicoes: '1=1',
        parametros: []
      };
    }
  
    const condicoes = [];
    const parametros = [];
    let idx = 1;
  
    tokens.forEach(token => {
      condicoes.push(`p.descricao ILIKE $${idx++}`);
      parametros.push(`%${token}%`);
    });
  
    // ✅ MUDANÇA CRÍTICA: OR ao invés de AND
    return {
      condicoes: condicoes.join(' OR '),
      parametros
    };
  }
  
  module.exports = {
    normalizarTermoBusca,
    expandirAbreviacoes,
    gerarCondicoesBusca,
    gerarCondicoesBuscaComRanking  // ✅ NOVA FUNÇÃO COM RANKING
  };
