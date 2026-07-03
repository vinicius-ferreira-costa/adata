/**
 * notas.js — cálculos da aba de notas, replicando a lógica da Adalove.
 *
 * Módulo PURO (sem Chrome API): testável em Node e usado no popup via o
 * global AdataNotas.
 *
 * Vocabulário:
 *   avaliação = { uuid, titulo, semana, categoria, peso, nota }
 *     - nota === null significa "ainda não lançada".
 *   média "até o momento"  = ponderada só das avaliações COM nota.
 *   média "acumulada"      = ponderada sobre TODOS os pesos, tratando nota
 *                            não lançada como 0 (é assim que a Adalove mostra
 *                            a nota "garantida até agora").
 */

"use strict";

// As três categorias de avaliação da Adalove. Usadas para o desempenho por
// categoria; valores fora disso caem em "Outros" em vez de sumir.
const CATEGORIAS = ["Ponderada", "Aula", "Artefato"];

/**
 * Faixas de participação e seu efeito sobre a média, conforme a régua da
 * Adalove: A soma 5%, B é neutro, C/D/E descontam 5/10/15%.
 */
const FAIXAS_PARTICIPACAO = { A: 0.05, B: 0, C: -0.05, D: -0.1, E: -0.15 };

// ---------------------------------------------------------------------------
// Normalização das avaliações cruas
// ---------------------------------------------------------------------------

/** Primeiro campo NUMÉRICO válido dentre os candidatos (aceita "8,5"/"8.5"). */
function pegarNumero(objeto, candidatos) {
  for (const nome of candidatos) {
    const valor = objeto[nome];
    if (typeof valor === "number" && Number.isFinite(valor)) return valor;
    if (typeof valor === "string" && valor.trim() !== "") {
      const numero = parseFloat(valor.replace(",", "."));
      if (Number.isFinite(numero)) return numero;
    }
  }
  return null;
}

function pegarTexto(objeto, candidatos) {
  for (const nome of candidatos) {
    const valor = objeto[nome];
    if (typeof valor === "string" && valor.trim() !== "") return valor.trim();
  }
  return "";
}

/** "Semana 09" → 9; sem número → Infinity (vai para o fim da ordenação). */
function semanaDe(texto) {
  if (typeof texto !== "string") return Infinity;
  const casamento = texto.match(/(\d+)/);
  return casamento ? parseInt(casamento[1], 10) : Infinity;
}

/**
 * Códigos do campo `type` da API real, observados ao vivo:
 *   11 = autoestudo (os com gradeWeight > 0 são as Ponderadas)
 *   21 = artefato de projeto ("Art. N [WAD] ...")
 *    1 = encontro/evento (workshop, apresentação, sprint planning)
 *    2 = instrução/aula expositiva
 */
const CATEGORIA_POR_TYPE = { 11: "Ponderada", 21: "Artefato", 1: "Aula", 2: "Aula" };

/**
 * Mapeia a categoria: primeiro pelo código `type` da API real; se não
 * houver, tenta casar por texto (tolerância a variações futuras).
 */
function categoriaDe(type, texto) {
  const porType = CATEGORIA_POR_TYPE[Number(type)];
  if (porType) return porType;
  const chave = String(texto || "").toLowerCase();
  for (const categoria of CATEGORIAS) {
    if (chave.includes(categoria.toLowerCase())) return categoria;
  }
  return "Outros";
}

/**
 * Converte a lista crua de registros de nota da API em avaliações no formato
 * interno, deduplicadas por uuid e ORDENADAS POR SEMANA — resolve a dor de
 * caçar a atividade certa numa lista embaralhada na hora de simular.
 *
 * Campos procurados em vários nomes porque o contrato da API é desconhecido
 * (mesmo racional defensivo de normalize.js).
 *
 * @param {object[]} listaCrua registros brutos vindos do storage.
 * @returns {object[]} avaliações { uuid, titulo, semana, categoria, peso, nota, bruto }
 */
function normalizarAvaliacoes(listaCrua) {
  if (!Array.isArray(listaCrua)) return [];

  const porUuid = new Map();
  for (const bruta of listaCrua) {
    if (!bruta || typeof bruta !== "object") continue;
    const uuid = bruta.studentActivityUuid || bruta.uuid || bruta.id;
    if (!uuid) continue;

    const peso = pegarNumero(bruta, ["gradeWeight", "weight", "peso"]) ?? 1;
    // Só entra quem VALE nota: na API real todo card tem gradeWeight, e o
    // valor 0 significa "não avaliado". Sem este filtro a lista de
    // avaliações afogaria as 32 ponderadas no meio de ~275 cards.
    if (peso <= 0) continue;

    // gradeResult é o campo real da nota — vem como STRING ("9.2") e usa -1
    // como sentinela de "não lançada". Convertidos aqui para number|null.
    let nota = pegarNumero(bruta, ["gradeResult", "grade", "nota", "gradeValue", "finalGrade", "score"]);
    if (nota !== null && nota < 0) nota = null;

    porUuid.set(uuid, {
      uuid,
      titulo: pegarTexto(bruta, ["caption", "title", "titulo", "name", "activityName"]),
      semana: semanaDe(pegarTexto(bruta, ["folderCaption", "week", "semana"])),
      categoria: categoriaDe(bruta.type, pegarTexto(bruta, ["category", "categoria", "gradeCategory"])),
      peso,
      nota,
      bruto: bruta,
    });
  }

  const avaliacoes = [...porUuid.values()];
  avaliacoes.sort((a, b) => {
    if (a.semana !== b.semana) return a.semana - b.semana;
    return a.titulo.localeCompare(b.titulo, "pt-BR");
  });
  return avaliacoes;
}

// ---------------------------------------------------------------------------
// Médias
// ---------------------------------------------------------------------------

/**
 * Média ponderada "até o momento": considera APENAS avaliações com nota
 * lançada. Retorna null quando não há nenhuma (exibir 0 seria mentir que o
 * aluno está indo mal antes da primeira nota sair).
 */
function mediaAteOMomento(avaliacoes) {
  let somaNotas = 0;
  let somaPesos = 0;
  for (const a of avaliacoes || []) {
    if (a.nota === null || a.nota === undefined) continue;
    somaNotas += a.nota * a.peso;
    somaPesos += a.peso;
  }
  return somaPesos > 0 ? somaNotas / somaPesos : null;
}

/**
 * Média "acumulada": pondera sobre o peso TOTAL do módulo, com nota não
 * lançada valendo 0. É a leitura "quanto eu já garanti do módulo inteiro".
 */
function mediaAcumulada(avaliacoes) {
  let somaNotas = 0;
  let somaPesos = 0;
  for (const a of avaliacoes || []) {
    somaNotas += (a.nota ?? 0) * a.peso;
    somaPesos += a.peso;
  }
  return somaPesos > 0 ? somaNotas / somaPesos : null;
}

/**
 * Desempenho por categoria: média "até o momento" de cada uma das três
 * categorias (e "Outros" se aparecer algo fora do padrão).
 *
 * @returns {Object<string,{media: number|null, quantidade: number}>}
 */
function desempenhoPorCategoria(avaliacoes) {
  const grupos = {};
  for (const a of avaliacoes || []) {
    (grupos[a.categoria] ??= []).push(a);
  }
  const resultado = {};
  for (const [categoria, lista] of Object.entries(grupos)) {
    resultado[categoria] = { media: mediaAteOMomento(lista), quantidade: lista.length };
  }
  return resultado;
}

/**
 * Aplica a faixa de participação sobre uma média: A soma 5%, B é neutro,
 * C/D/E descontam. Resultado limitado a [0, 10] — a régua não cria nota
 * acima do teto nem negativa.
 *
 * @param {number|null} media
 * @param {"A"|"B"|"C"|"D"|"E"} faixa
 * @returns {number|null}
 */
function aplicarParticipacao(media, faixa) {
  if (media === null || media === undefined) return null;
  const ajuste = FAIXAS_PARTICIPACAO[faixa];
  if (ajuste === undefined) return media; // faixa desconhecida: não altera
  const ajustada = media * (1 + ajuste);
  return Math.min(10, Math.max(0, ajustada));
}

// ---------------------------------------------------------------------------
// Simulação
// ---------------------------------------------------------------------------

/**
 * Simulação direta: recalcula a média acumulada supondo notas hipotéticas.
 * Não muta a lista original — o popup chama isso a cada tecla digitada e a
 * lista real precisa continuar refletindo só o que foi capturado.
 *
 * @param {object[]} avaliacoes
 * @param {Object<string, number>} alteracoes mapa uuid → nota hipotética.
 * @returns {{ mediaAcumulada: number|null, mediaAteOMomento: number|null }}
 */
function simular(avaliacoes, alteracoes) {
  const hipoteticas = (avaliacoes || []).map((a) =>
    alteracoes && Object.prototype.hasOwnProperty.call(alteracoes, a.uuid)
      ? { ...a, nota: alteracoes[a.uuid] }
      : a
  );
  return {
    mediaAcumulada: mediaAcumulada(hipoteticas),
    mediaAteOMomento: mediaAteOMomento(hipoteticas),
  };
}

/**
 * Simulador REVERSO: quanto preciso tirar na avaliação-alvo para fechar o
 * módulo com a média desejada?
 *
 * Modelo: média acumulada (peso total do módulo, não lançadas = 0, exceto a
 * alvo, que é a incógnita). Álgebra:
 *   mediaDesejada = (somaOutros + nota * pesoAlvo) / pesoTotal
 *   nota = (mediaDesejada * pesoTotal - somaOutros) / pesoAlvo
 *
 * O resultado NÃO é truncado a [0, 10] de propósito: um retorno de 14.2
 * comunica "impossível, mesmo gabaritando" e -1.5 comunica "já garantido" —
 * informação que o popup usa para dar a resposta honesta ao aluno.
 *
 * @param {object[]} avaliacoes
 * @param {string} uuidAlvo uuid da avaliação onde a nota será tirada.
 * @param {number} mediaDesejada média final que o aluno quer.
 * @returns {number|null} nota necessária, ou null se a avaliação não existe
 *          ou tem peso 0 (nota nela não move a média — não há resposta).
 */
function notaNecessaria(avaliacoes, uuidAlvo, mediaDesejada) {
  const lista = avaliacoes || [];
  const alvo = lista.find((a) => a.uuid === uuidAlvo);
  if (!alvo || alvo.peso === 0) return null;

  let somaOutros = 0;
  let pesoTotal = 0;
  for (const a of lista) {
    pesoTotal += a.peso;
    if (a.uuid !== uuidAlvo) somaOutros += (a.nota ?? 0) * a.peso;
  }
  if (pesoTotal === 0) return null;

  return (mediaDesejada * pesoTotal - somaOutros) / alvo.peso;
}

// ---------------------------------------------------------------------------
// Evolução da média por semana
// ---------------------------------------------------------------------------

/**
 * Série temporal da média: para cada semana que tem nota lançada, a média
 * ponderada ACUMULADA considerando tudo que foi lançado até aquela semana
 * (inclusive). É a curva "como minha média caminhou ao longo do módulo".
 *
 * Semana Infinity (avaliação sem semana) fica de fora da curva — não há
 * onde plotá-la no eixo do tempo.
 *
 * @param {object[]} avaliacoes normalizadas (com semana, peso, nota).
 * @returns {{semana: number, media: number}[]} ordenado por semana.
 */
function evolucaoPorSemana(avaliacoes) {
  const comNota = (avaliacoes || []).filter(
    (a) => a.nota !== null && a.nota !== undefined && Number.isFinite(a.semana)
  );
  const semanas = [...new Set(comNota.map((a) => a.semana))].sort((x, y) => x - y);

  return semanas.map((semana) => ({
    semana,
    media: mediaAteOMomento(comNota.filter((a) => a.semana <= semana)),
  }));
}

/**
 * Média ponderada APENAS das notas lançadas em cada semana (sem acumular).
 * Alimenta as barras do gráfico: a barra mostra "como foi aquela semana",
 * a linha da acumulada (evolucaoPorSemana) mostra "como a média caminhou".
 *
 * @param {object[]} avaliacoes normalizadas.
 * @returns {{semana: number, media: number}[]} ordenado por semana.
 */
function mediasDaSemana(avaliacoes) {
  const comNota = (avaliacoes || []).filter(
    (a) => a.nota !== null && a.nota !== undefined && Number.isFinite(a.semana)
  );
  const semanas = [...new Set(comNota.map((a) => a.semana))].sort((x, y) => x - y);

  return semanas.map((semana) => ({
    semana,
    media: mediaAteOMomento(comNota.filter((a) => a.semana === semana)),
  }));
}

// ---------------------------------------------------------------------------
// Junção nota ↔ instrução (v4.1)
// ---------------------------------------------------------------------------

/**
 * Enriquece cada avaliação com os dados do card de instrução correspondente
 * (link, descrição, eixo), para o aluno abrir o enunciado direto da aba de
 * notas.
 *
 * Estratégia em duas camadas:
 *   1. uuid — no contrato atual da API a ponderada É o próprio card
 *      (mesmo studentActivityUuid), então o casamento é direto;
 *   2. chaveJuncao(título) — rede de segurança para o dia em que notas e
 *      instruções vierem em registros separados (o plano original da v4.1).
 *
 * Não muta as listas de entrada.
 *
 * @param {object[]} avaliacoes normalizadas (AdataNotas).
 * @param {object[]} atividades normalizadas (AdataNormalize), com link/descricao/eixo.
 * @param {(texto: string) => string} chaveJuncao injetada para manter este
 *        módulo independente de normalize.js (cada um roda isolado em Node).
 * @returns {object[]} avaliações com { link, descricao, eixo } preenchidos
 *          quando houver instrução casada ("" quando não houver).
 */
function juntarComInstrucoes(avaliacoes, atividades, chaveJuncao) {
  const porUuid = new Map();
  const porTitulo = new Map();
  for (const atividade of atividades || []) {
    porUuid.set(atividade.uuid, atividade);
    const chave = chaveJuncao ? chaveJuncao(atividade.titulo) : "";
    if (chave && !porTitulo.has(chave)) porTitulo.set(chave, atividade);
  }

  return (avaliacoes || []).map((avaliacao) => {
    const instrucao =
      porUuid.get(avaliacao.uuid) ||
      (chaveJuncao ? porTitulo.get(chaveJuncao(avaliacao.titulo)) : undefined);
    return {
      ...avaliacao,
      link: instrucao ? instrucao.link : "",
      descricao: instrucao ? instrucao.descricao : "",
      eixo: instrucao ? instrucao.eixo : "",
    };
  });
}

// ---------------------------------------------------------------------------
// Frequência
// ---------------------------------------------------------------------------

/**
 * Calcula a frequência direto dos cards capturados da API.
 *
 * Contrato observado ao vivo: cada card de encontro traz attendance1,
 * attendance2 e attendance3 (três check-ins por dia de aula), onde
 * 10 = presente, 0 = falta e -1 = check-in que não se aplica ao card.
 *
 * Limite de faltas: 20% do total de check-ins do módulo. Calibrado contra a
 * própria Adalove — módulo com 135 check-ins exibe limite de 27 faltas
 * (27/135 = 20%) e "cada check-in vale 0,74%" (1/135). Parametrizado para o
 * dia em que a regra institucional mudar.
 *
 * @param {object[]} atividadesCruas cards brutos capturados (com attendance*).
 * @param {number} [limitePercentual=0.20] fração de faltas tolerada.
 * @returns {{
 *   totalCheckins: number,   // check-ins existentes no módulo
 *   presentes: number,
 *   faltas: number,
 *   limite: number,          // máximo de faltas antes de reprovar
 *   restantes: number,       // quantas ainda pode perder
 *   diasRestantes: number,   // idem, em dias (3 check-ins = 1 dia)
 *   valorCheckin: number,    // % da presença que 1 check-in representa
 *   percentualFaltas: number,
 *   estourou: boolean
 * }|null} null quando não há nenhum check-in nos dados (sem captura ainda).
 */
function calcularFrequencia(atividadesCruas, limitePercentual = 0.2) {
  let totalCheckins = 0;
  let presentes = 0;
  let faltas = 0;

  for (const card of atividadesCruas || []) {
    if (!card || typeof card !== "object") continue;
    for (const slot of [card.attendance1, card.attendance2, card.attendance3]) {
      if (slot === -1 || slot === undefined || slot === null) continue; // não se aplica
      totalCheckins++;
      if (slot === 0) faltas++;
      else presentes++;
    }
  }

  if (totalCheckins === 0) return null;

  const limite = Math.floor(totalCheckins * limitePercentual);
  return {
    totalCheckins,
    presentes,
    faltas,
    limite,
    restantes: Math.max(0, limite - faltas),
    diasRestantes: Math.floor(Math.max(0, limite - faltas) / 3),
    valorCheckin: 100 / totalCheckins,
    percentualFaltas: (faltas / totalCheckins) * 100,
    estourou: faltas > limite,
  };
}

// UMD manual — mesmo racional de normalize.js.
const API_NOTAS = {
  CATEGORIAS,
  CATEGORIA_POR_TYPE,
  FAIXAS_PARTICIPACAO,
  normalizarAvaliacoes,
  mediaAteOMomento,
  mediaAcumulada,
  desempenhoPorCategoria,
  aplicarParticipacao,
  simular,
  notaNecessaria,
  calcularFrequencia,
  evolucaoPorSemana,
  mediasDaSemana,
  juntarComInstrucoes,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = API_NOTAS;
} else {
  globalThis.AdataNotas = API_NOTAS;
}
