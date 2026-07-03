/**
 * normalize.js — camada de normalização dos autoestudos.
 *
 * Módulo PURO: sem nenhuma Chrome API, roda tanto no browser (popup, via
 * <script> comum, expondo o global AdataNormalize) quanto em Node (testes
 * Jest, via module.exports). O padrão UMD manual no fim do arquivo existe
 * exatamente para permitir esses dois mundos sem build step.
 */

"use strict";

// Os cinco eixos válidos do Inteli — qualquer outro valor vindo da API é
// tratado como não confiável e cai para as camadas seguintes da cascata.
const EIXOS_VALIDOS = ["Computação", "Design", "Matemática", "Liderança", "Negócios"];

/**
 * Normaliza um texto para servir de chave de junção: minúsculo, sem acento
 * (NFD separa a letra do diacrítico; o replace remove só o diacrítico) e
 * apenas alfanumérico. Serve para casar títulos entre a aba de notas e os
 * cards de instrução (evolução v4.1) e para comparar nomes de professores
 * sem sofrer com "Andréa" × "Andrea".
 *
 * @param {string} texto
 * @returns {string}
 */
function chaveJuncao(texto) {
  if (typeof texto !== "string") return "";
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove os diacríticos separados pelo NFD (faixa U+0300–U+036F dos combining marks)
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Mapa professor → eixo, usado APENAS como rede de segurança quando o payload
 * não traz um campo estruturado de eixo.
 *
 * ATENÇÃO — mapa FRÁGIL por natureza: foi derivado de dados reais de um
 * módulo específico. Professores mudam de módulo a cada trimestre; se o eixo
 * resolvido parecer errado, é aqui que se ajusta. Nunca é a fonte primária.
 *
 * Chaves já normalizadas via chaveJuncao para casar independente de acento.
 */
const MAPA_PROFESSOR_EIXO = {
  [chaveJuncao("Andréa Zotovici")]: "Computação",
  [chaveJuncao("Fernando Pizzo Ribeiro")]: "Matemática",
  [chaveJuncao("Ana Cristina dos Santos")]: "Design",
  [chaveJuncao("Fábio Cássio de Souza")]: "Negócios",
  // Julia Stateri fica FORA de propósito: ela é orientadora — os cards dela
  // vêm com axisCaption null e pertencem a "Orientação", não a Liderança.
  // Mapeá-la aqui roubaria esses cards do balde certo.
  [chaveJuncao("Vanessa Tavares Nunes")]: "Liderança",
};

// Índice dos eixos válidos por chave normalizada, para reconhecer o campo
// estruturado mesmo que venha como "computacao" ou "COMPUTAÇÃO".
const EIXOS_POR_CHAVE = Object.fromEntries(EIXOS_VALIDOS.map((e) => [chaveJuncao(e), e]));

// A API real (observada ao vivo em /sections/{uuid}/userdata) manda o eixo
// como SIGLA no campo axisCaption: COM, MTF, NEG, UEX, LID (e null quando o
// card não pertence a eixo nenhum). Mapeamos as siglas para os nomes cheios:
// MTF = Matemática e Física → Matemática; UEX = User Experience → Design.
const SIGLAS_EIXO = {
  COM: "Computação",
  MTF: "Matemática",
  NEG: "Negócios",
  UEX: "Design",
  LID: "Liderança",
};

// Entidades HTML → caractere. As descrições da Adalove vêm com os acentos
// TODOS escapados (voc&ecirc;, s&atilde;o...) — sem esta tabela o texto
// exportado fica ilegível. Cobre o latim usado em pt-BR + pontuação comum.
const ENTIDADES_HTML = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", ordf: "ª", ordm: "º", deg: "°",
  hellip: "…", ndash: "–", mdash: "—",
  lsquo: "'", rsquo: "'", ldquo: "“", rdquo: "”",
};

/**
 * Remove HTML de um texto rico da API (as descrições dos cards vêm com
 * markup do editor da Adalove). Sem DOM de propósito: precisa rodar em Node
 * (testes) igual ao browser. Block tags viram quebra de linha para preservar
 * parágrafos no Markdown; o resto é descartado. Entidades nomeadas (com
 * maiúscula inicial respeitada: &Eacute; → É) e numéricas são decodificadas.
 */
function limparHTML(texto) {
  return String(texto)
    .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (original, nome) => {
      const caractere = ENTIDADES_HTML[nome.toLowerCase()];
      if (caractere === undefined) return original; // entidade desconhecida: preserva
      // &Eacute; (maiúscula inicial) → versão maiúscula do caractere.
      return nome[0] === nome[0].toUpperCase() ? caractere.toUpperCase() : caractere;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Devolve o primeiro campo string não vazio dentre os candidatos.
 * O contrato da API é desconhecido, então cada informação é procurada em
 * vários nomes de campo plausíveis.
 */
function pegarCampo(objeto, candidatos) {
  if (!objeto || typeof objeto !== "object") return "";
  for (const nome of candidatos) {
    const valor = objeto[nome];
    if (typeof valor === "string" && valor.trim() !== "") return valor.trim();
  }
  return "";
}

// axisCaption primeiro: é o campo confirmado da API real; os demais ficam
// como tolerância a variações futuras do contrato.
const CAMPOS_EIXO = ["axisCaption", "eixo", "axis", "axisName", "subject", "subjectArea", "area"];
const CAMPOS_PROFESSOR = ["professorName", "professor", "teacherName", "teacher", "instructorName", "instructor"];
// caption primeiro: campo real de título na API.
const CAMPOS_TITULO = ["caption", "title", "titulo", "name", "activityName"];
// basicActivityURL é o campo real do link do card.
const CAMPOS_LINK = ["basicActivityURL", "link", "url", "linkUrl", "activityLink"];
const CAMPOS_DESCRICAO = ["description", "descricao", "details", "body", "text"];

/**
 * Resolve o eixo de uma atividade com cascata de TRÊS fontes, na ordem:
 *   1. Campo estruturado de eixo vindo no payload — mas só se for um dos
 *      cinco eixos válidos (a API pode trazer lixo ou categorias internas).
 *   2. Fallback pelo mapa professor → eixo (rede de segurança frágil).
 *   3. "Orientação" — na API real, card sem eixo (axisCaption null) é
 *      atividade de orientação (sprint review, workshop, encontro com a
 *      orientadora). Continua valendo o "nunca chutar um dos cinco eixos":
 *      é um sexto balde, com o nome que o aluno reconhece.
 *
 * @param {object} atividade objeto bruto da API.
 * @returns {string} um dos cinco eixos válidos ou "Orientação".
 */
function resolverEixo(atividade) {
  // 1ª fonte: campo estruturado — sigla da API (COM/MTF/...) ou nome cheio.
  const eixoDeclarado = pegarCampo(atividade, CAMPOS_EIXO);
  const porSigla = SIGLAS_EIXO[eixoDeclarado.toUpperCase()];
  if (porSigla) return porSigla;
  const eixoValido = EIXOS_POR_CHAVE[chaveJuncao(eixoDeclarado)];
  if (eixoValido) return eixoValido;

  // 2ª fonte: professor conhecido.
  const professor = pegarCampo(atividade, CAMPOS_PROFESSOR);
  const eixoDoProfessor = MAPA_PROFESSOR_EIXO[chaveJuncao(professor)];
  if (eixoDoProfessor) return eixoDoProfessor;

  // 3ª fonte: sem eixo = orientação.
  return EIXO_SEM_EIXO;
}

// Rótulo do balde sem eixo — exportado para o popup montar o filtro sem
// duplicar a string.
const EIXO_SEM_EIXO = "Orientação";

/**
 * Tipo do card, derivado do código `type` da API + peso:
 *   type 11 + gradeWeight > 0 → Ponderada (autoestudo que vale nota)
 *   type 11                   → Autoestudo
 *   type 21                   → Artefato (entrega de projeto)
 *   type 1 ou 2               → Encontro (aula, workshop, evento)
 *   qualquer outro            → Outro (nunca escondemos card por tipo novo)
 */
function tipoDoCard(atividade) {
  const type = Number(atividade && atividade.type);
  const peso = Number(atividade && atividade.gradeWeight) || 0;
  if (type === 11) return peso > 0 ? "Ponderada" : "Autoestudo";
  if (type === 21) return "Artefato";
  if (type === 1 || type === 2) return "Encontro";
  return "Outro";
}

const TIPOS_CARD = ["Autoestudo", "Ponderada", "Artefato", "Encontro", "Outro"];

/**
 * Extrai o número da semana de um folderCaption tipo "Semana 09" → 9.
 *
 * Retorna Infinity quando não há número: assim, na ordenação crescente por
 * semana, as atividades sem semana caem naturalmente para o FIM da lista em
 * vez de poluir o topo (0 ou -1 as colocaria antes da Semana 1).
 *
 * @param {string} folderCaption
 * @returns {number}
 */
function numeroSemana(folderCaption) {
  if (typeof folderCaption !== "string") return Infinity;
  const casamento = folderCaption.match(/(\d+)/);
  return casamento ? parseInt(casamento[1], 10) : Infinity;
}

/**
 * Normaliza a lista crua de atividades capturadas:
 *   - deduplica por studentActivityUuid (a mesma atividade chega várias vezes
 *     conforme o aluno navega; a ocorrência mais RECENTE vence, pois pode
 *     trazer dados atualizados);
 *   - resolve o eixo (cascata de resolverEixo);
 *   - extrai o número da semana;
 *   - ordena por semana e, dentro da semana, por título.
 *
 * @param {object[]} listaCrua objetos brutos da API.
 * @returns {object[]} atividades normalizadas:
 *          { uuid, titulo, semana, eixo, professor, link, descricao, bruto }
 */
function normalizarAtividades(listaCrua) {
  if (!Array.isArray(listaCrua)) return [];

  const porUuid = new Map();
  for (const bruta of listaCrua) {
    if (!bruta || typeof bruta !== "object") continue;
    const uuid = bruta.studentActivityUuid || bruta.uuid || bruta.id;
    if (!uuid) continue; // sem identidade não há como deduplicar com segurança
    porUuid.set(uuid, bruta); // Map preserva ordem; set repetido = última vence
  }

  const normalizadas = [...porUuid.entries()].map(([uuid, bruta]) => ({
    uuid,
    titulo: pegarCampo(bruta, CAMPOS_TITULO),
    semana: numeroSemana(bruta.folderCaption),
    eixo: resolverEixo(bruta),
    tipo: tipoDoCard(bruta),
    professor: pegarCampo(bruta, CAMPOS_PROFESSOR),
    link: pegarCampo(bruta, CAMPOS_LINK),
    // Descrição limpa de HTML: vai para CSV/Markdown/tooltip — markup cru
    // deixaria a exportação ilegível.
    descricao: limparHTML(pegarCampo(bruta, CAMPOS_DESCRICAO)),
    // Mantemos o objeto bruto por perto: a junção nota↔instrução (v4.1) e
    // futuros campos vão precisar dele sem exigir recaptura.
    bruto: bruta,
  }));

  normalizadas.sort((a, b) => {
    if (a.semana !== b.semana) return a.semana - b.semana; // Infinity vai pro fim
    return a.titulo.localeCompare(b.titulo, "pt-BR");
  });

  return normalizadas;
}

// ---------------------------------------------------------------------------
// UMD manual: Node (Jest) usa module.exports; o browser usa o global.
// ---------------------------------------------------------------------------
const API_NORMALIZE = {
  EIXOS_VALIDOS,
  EIXO_SEM_EIXO,
  TIPOS_CARD,
  MAPA_PROFESSOR_EIXO,
  SIGLAS_EIXO,
  chaveJuncao,
  limparHTML,
  resolverEixo,
  tipoDoCard,
  numeroSemana,
  normalizarAtividades,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = API_NORMALIZE;
} else {
  globalThis.AdataNormalize = API_NORMALIZE;
}
