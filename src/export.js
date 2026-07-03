/**
 * export.js — geração de CSV e Markdown a partir das atividades normalizadas.
 *
 * Módulo PURO (sem Chrome API): testável em Node e usado no popup via o
 * global AdataExport. Recebe SEMPRE atividades já normalizadas por
 * normalize.js — este módulo não sabe nada sobre o formato da API.
 */

"use strict";

// Ordem fixa das colunas do CSV. Fixa de propósito: quem importa o CSV em
// planilha/script conta com posições estáveis entre versões.
const COLUNAS_CSV = ["uuid", "titulo", "semana", "eixo", "tipo", "professor", "link", "descricao"];

// Separador ponto-e-vírgula, não vírgula: o Excel em português (locale
// pt-BR) usa ";" como separador de lista — CSV com vírgula abre tudo numa
// coluna só, que era exatamente a "formatação horrível" em tabela.
const SEPARADOR_CSV = ";";

// BOM UTF-8: sem ele o Excel assume ANSI e transforma acentos em lixo
// (Ã§, Ã£...). Invisível para qualquer outro leitor de CSV.
// fromCharCode em vez de literal: o caractere é invisível no editor.
const BOM = String.fromCharCode(0xfeff);

/**
 * Escapa um valor para célula de CSV (RFC 4180 adaptado ao separador ";"):
 * envolve em aspas duplas quando contém separador, vírgula ou aspas, e
 * dobra as aspas internas. Sem esse escape, uma descrição com ";" desloca
 * todas as colunas seguintes e corrompe a linha inteira.
 *
 * Quebras de linha viram espaço ANTES do escape: célula multilinha é válida
 * pelo RFC, mas no Excel vira uma linha gigante que desmonta a leitura da
 * tabela — para planilha, um registro = uma linha. Os parágrafos completos
 * continuam disponíveis no Markdown/JSON.
 */
function escaparCSV(valor) {
  const texto = (valor === null || valor === undefined ? "" : String(valor))
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
  if (/[";,]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

/** Semana legível: Infinity (sem semana) vira texto amigável, não "Infinity". */
function semanaLegivel(semana) {
  return Number.isFinite(semana) ? String(semana) : "sem semana";
}

/**
 * Gera o CSV completo (cabeçalho + uma linha por atividade).
 *
 * @param {object[]} atividades normalizadas (saída de normalizarAtividades).
 * @returns {string}
 */
function paraCSV(atividades) {
  const linhas = [COLUNAS_CSV.join(SEPARADOR_CSV)];
  for (const atividade of atividades || []) {
    const linha = COLUNAS_CSV.map((coluna) => {
      const valor = coluna === "semana" ? semanaLegivel(atividade.semana) : atividade[coluna];
      return escaparCSV(valor);
    });
    linhas.push(linha.join(SEPARADOR_CSV));
  }
  // BOM na frente + \r\n: é o que faz o Excel pt-BR abrir direto em tabela,
  // com acento certo e uma coluna por campo.
  return BOM + linhas.join("\r\n");
}

/**
 * Gera Markdown agrupado por semana, formatado para colar direto num projeto
 * de LLM: cabeçalhos hierárquicos dão estrutura que o modelo entende, e a
 * descrição vai COMPLETA porque é ela que carrega o contexto da instrução.
 *
 * Formato:
 *   ## Semana N
 *   ### Título da atividade
 *   - **Eixo:** ...
 *   - **Professor:** ...
 *   - **Link:** ...       (só quando existir)
 *   (descrição completa)
 *
 * @param {object[]} atividades normalizadas E JÁ ORDENADAS por semana
 *        (normalizarAtividades garante a ordenação; aqui só agrupamos).
 * @returns {string}
 */
function paraMarkdown(atividades) {
  const blocos = [];
  let semanaAtual = null;

  for (const atividade of atividades || []) {
    if (atividade.semana !== semanaAtual) {
      semanaAtual = atividade.semana;
      const rotulo = Number.isFinite(semanaAtual) ? `Semana ${semanaAtual}` : "Sem semana";
      blocos.push(`## ${rotulo}`);
    }

    const linhas = [`### ${atividade.titulo || "(sem título)"}`];
    linhas.push(`- **Eixo:** ${atividade.eixo}`);
    if (atividade.tipo) linhas.push(`- **Tipo:** ${atividade.tipo}`);
    if (atividade.professor) linhas.push(`- **Professor:** ${atividade.professor}`);
    if (atividade.link) linhas.push(`- **Link:** ${atividade.link}`);
    if (atividade.descricao) {
      linhas.push(""); // linha em branco separa metadados da descrição
      linhas.push(atividade.descricao);
    }
    blocos.push(linhas.join("\n"));
  }

  return blocos.join("\n\n") + (blocos.length ? "\n" : "");
}

/**
 * JSON estruturado: para quem quer processar os dados em script próprio sem
 * fazer parse de CSV. Exporta os campos normalizados, sem o objeto bruto
 * (que é grande e tem contrato instável).
 */
function paraJSON(atividades) {
  const limpas = (atividades || []).map(({ uuid, titulo, semana, eixo, tipo, professor, link, descricao }) => ({
    uuid,
    titulo,
    semana: Number.isFinite(semana) ? semana : null,
    eixo,
    tipo,
    professor,
    link,
    descricao,
  }));
  return JSON.stringify(limpas, null, 2);
}

// UMD manual — mesmo racional de normalize.js.
const API_EXPORT = { paraCSV, paraMarkdown, paraJSON, escaparCSV };

if (typeof module !== "undefined" && module.exports) {
  module.exports = API_EXPORT;
} else {
  globalThis.AdataExport = API_EXPORT;
}
