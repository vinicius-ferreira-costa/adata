/**
 * xlsx.js — gerador de planilha .xlsx SEM bibliotecas.
 *
 * Por quê na mão? O projeto é vanilla por requisito, e um .xlsx é só um ZIP
 * de XMLs (Open Packaging Conventions). Usamos entradas ZIP SEM compressão
 * ("stored"): dispensa implementar DEFLATE, o arquivo continua pequeno para
 * este volume de dados e — bônus para os testes — o conteúdo fica legível
 * dentro dos bytes.
 *
 * Módulo PURO: sem Chrome API e sem DOM; roda em Node (testes) e no popup
 * (global AdataXLSX). Depende só de TextEncoder, disponível nos dois.
 */

"use strict";

// ---------------------------------------------------------------------------
// ZIP (formato "stored", sem compressão)
// ---------------------------------------------------------------------------

// Tabela padrão do CRC-32 (polinômio 0xEDB88320) — o ZIP exige o checksum.
const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const codificador = new TextEncoder();

// Data DOS fixa (01/01/2026): o campo é obrigatório, mas carimbo real de
// hora tornaria o arquivo não determinístico e quebraria os testes.
const DATA_DOS = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * Monta um ZIP com entradas "stored".
 * @param {{nome: string, texto: string}[]} arquivos
 * @returns {Uint8Array}
 */
function montarZip(arquivos) {
  const partes = [];
  const centrais = [];
  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = codificador.encode(arquivo.nome);
    const dados = codificador.encode(arquivo.texto);
    const crc = crc32(dados);

    // Cabeçalho local (30 bytes fixos + nome).
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // assinatura
    local.setUint16(4, 20, true); // versão mínima
    local.setUint16(6, 0x0800, true); // flag: nomes em UTF-8
    local.setUint16(8, 0, true); // método 0 = stored
    local.setUint16(10, 0, true); // hora DOS
    local.setUint16(12, DATA_DOS, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, dados.length, true); // comprimido = original (stored)
    local.setUint32(22, dados.length, true);
    local.setUint16(26, nome.length, true);
    local.setUint16(28, 0, true); // sem campo extra

    partes.push(new Uint8Array(local.buffer), nome, dados);

    // Registro do diretório central (46 bytes fixos + nome).
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // versão criadora
    central.setUint16(6, 20, true); // versão mínima
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, DATA_DOS, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, dados.length, true);
    central.setUint32(24, dados.length, true);
    central.setUint16(28, nome.length, true);
    // extra, comentário, disco, atributos internos/externos: zeros.
    central.setUint32(42, deslocamento, true); // offset do cabeçalho local
    centrais.push(new Uint8Array(central.buffer), nome);

    deslocamento += 30 + nome.length + dados.length;
  }

  const tamanhoCentral = centrais.reduce((soma, p) => soma + p.length, 0);

  // End of Central Directory.
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamanhoCentral, true);
  fim.setUint32(16, deslocamento, true);

  const total = deslocamento + tamanhoCentral + 22;
  const saida = new Uint8Array(total);
  let posicao = 0;
  for (const parte of [...partes, ...centrais, new Uint8Array(fim.buffer)]) {
    saida.set(parte, posicao);
    posicao += parte.length;
  }
  return saida;
}

// ---------------------------------------------------------------------------
// XML da pasta de trabalho
// ---------------------------------------------------------------------------

function escaparXML(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → A, 1 → B, ... 26 → AA (referência de coluna do Excel). */
function colunaLetra(indice) {
  let letras = "";
  let n = indice + 1;
  while (n > 0) {
    const resto = (n - 1) % 26;
    letras = String.fromCharCode(65 + resto) + letras;
    n = Math.floor((n - 1) / 26);
  }
  return letras;
}

/**
 * Estilos disponíveis para as células (índices em cellXfs de styles.xml).
 * Poucos e nomeados de propósito: é o suficiente para uma planilha limpa
 * sem transformar este módulo num motor de estilos.
 */
const ESTILOS = {
  PADRAO: 0,
  CABECALHO: 1, // negrito branco sobre roxo, borda
  TEXTO: 2, // borda fina
  NUMERO: 3, // borda fina + formato 0.0
  PENDENTE: 4, // fundo âmbar, negrito — chama o olho para nota não lançada
  TITULO: 5, // negrito, sem borda — títulos de seção na aba de resumo
};

// styles.xml fixo. Atenção às duas primeiras fills: o formato RESERVA os
// índices 0 (none) e 1 (gray125); estilos custom começam no 2.
const XML_ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>
<font><b/><color rgb="FF92400E"/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF6D28D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/**
 * XML de uma aba.
 * @param {object} aba { larguras: number[], linhas: Celula[][], congelarCabecalho: boolean }
 *        Celula = { v: string|number, n?: boolean (numérica), s?: número do estilo }
 */
function xmlAba(aba) {
  const colunas = (aba.larguras || [])
    .map((largura, i) => `<col min="${i + 1}" max="${i + 1}" width="${largura}" customWidth="1"/>`)
    .join("");

  const linhas = (aba.linhas || [])
    .map((celulas, indiceLinha) => {
      const conteudo = celulas
        .map((celula, indiceColuna) => {
          if (celula === null || celula === undefined) return "";
          const referencia = `${colunaLetra(indiceColuna)}${indiceLinha + 1}`;
          const estilo = celula.s ?? ESTILOS.PADRAO;
          if (celula.n) {
            return `<c r="${referencia}" s="${estilo}"><v>${Number(celula.v)}</v></c>`;
          }
          // inlineStr em vez de sharedStrings: um XML a menos no pacote e
          // nenhuma contabilidade de índices; o custo (repetição de texto)
          // é irrelevante nesta escala.
          return `<c r="${referencia}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${escaparXML(celula.v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${indiceLinha + 1}">${conteudo}</row>`;
    })
    .join("");

  // Painel congelado: o cabeçalho continua visível ao rolar a lista.
  const vista = aba.congelarCabecalho
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${vista}${colunas ? `<cols>${colunas}</cols>` : ""}<sheetData>${linhas}</sheetData></worksheet>`;
}

/** Nome de aba válido para o Excel: sem []:*?/\ e no máximo 31 caracteres. */
function sanearNomeAba(nome) {
  return String(nome).replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Planilha";
}

/**
 * Gera a pasta de trabalho completa.
 * @param {object[]} abas [{ nome, larguras, linhas, congelarCabecalho }]
 * @returns {Uint8Array} bytes do .xlsx.
 */
function gerarPasta(abas) {
  const declaracoesAbas = abas
    .map((aba, i) => `<sheet name="${escaparXML(sanearNomeAba(aba.nome))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const relacoesAbas = abas
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  const tiposAbas = abas
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");

  const arquivos = [
    {
      nome: "[Content_Types].xml",
      texto: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${tiposAbas}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      nome: "_rels/.rels",
      texto: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nome: "xl/workbook.xml",
      texto: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${declaracoesAbas}</sheets></workbook>`,
    },
    {
      nome: "xl/_rels/workbook.xml.rels",
      texto: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relacoesAbas}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { nome: "xl/styles.xml", texto: XML_ESTILOS },
    ...abas.map((aba, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, texto: xmlAba(aba) })),
  ];

  return montarZip(arquivos);
}

// ---------------------------------------------------------------------------
// Planilha de notas (o consumidor concreto)
// ---------------------------------------------------------------------------

/**
 * Monta a pasta de trabalho de notas com duas abas:
 *   "Avaliações" — tabela completa ordenada por semana, cabeçalho congelado,
 *                  pendentes destacadas;
 *   "Resumo"     — médias, desempenho por categoria e frequência.
 *
 * Este módulo NÃO calcula nada: recebe avaliações enriquecidas e um resumo
 * prontos (popup calcula com notas.js) e só formata. Cálculo e formato
 * separados = cada um testável sozinho.
 *
 * @param {object[]} avaliacoes [{ semana, titulo, categoria, eixo, peso, nota }]
 * @param {object} resumo {
 *   turma, mediaAteOMomento, mediaAcumulada, mediaComFator,
 *   categorias: { [nome]: { media, quantidade } },
 *   frequencia: { presencaPct, faltas, limite, restantes } | null
 * }
 * @returns {Uint8Array}
 */
function planilhaDeNotas(avaliacoes, resumo) {
  const texto = (v, s = ESTILOS.TEXTO) => ({ v: v ?? "—", s });
  const numero = (v, s = ESTILOS.NUMERO) => (v === null || v === undefined ? texto("—", s === ESTILOS.NUMERO ? ESTILOS.TEXTO : s) : { v, n: true, s });

  const linhasAvaliacoes = [
    ["Semana", "Atividade", "Categoria", "Eixo", "Peso", "Nota", "Status"].map((titulo) => ({
      v: titulo,
      s: ESTILOS.CABECALHO,
    })),
    ...(avaliacoes || []).map((a) => {
      const pendente = a.nota === null || a.nota === undefined;
      return [
        Number.isFinite(a.semana) ? numero(a.semana) : texto("—"),
        texto(a.titulo),
        texto(a.categoria),
        texto(a.eixo || "—"),
        numero(a.peso),
        pendente ? texto("—", ESTILOS.PENDENTE) : numero(a.nota),
        pendente ? texto("Pendente", ESTILOS.PENDENTE) : texto("Lançada"),
      ];
    }),
  ];

  const linhasResumo = [];
  const titulo = (t) => linhasResumo.push([{ v: t, s: ESTILOS.TITULO }]);
  const par = (rotulo, valor, numerico = true) =>
    linhasResumo.push([texto(rotulo), numerico ? numero(valor) : texto(valor)]);

  titulo(`Resumo — ${resumo.turma || "módulo"}`);
  par("Média até o momento", resumo.mediaAteOMomento);
  par("Média acumulada", resumo.mediaAcumulada);
  par("Média com fator (oficial Adalove)", resumo.mediaComFator);
  linhasResumo.push([]);

  titulo("Desempenho por categoria");
  linhasResumo.push(
    ["Categoria", "Média", "Avaliações"].map((t) => ({ v: t, s: ESTILOS.CABECALHO }))
  );
  for (const [nome, dados] of Object.entries(resumo.categorias || {})) {
    linhasResumo.push([texto(nome), numero(dados.media), numero(dados.quantidade)]);
  }

  if (resumo.frequencia) {
    linhasResumo.push([]);
    titulo("Frequência");
    par("Presença (%)", resumo.frequencia.presencaPct);
    par("Faltas (check-ins)", resumo.frequencia.faltas);
    par("Limite de faltas (20%)", resumo.frequencia.limite);
    par("Margem restante", resumo.frequencia.restantes);
  }

  return gerarPasta([
    {
      nome: "Avaliações",
      larguras: [9, 52, 13, 13, 7, 7, 11],
      linhas: linhasAvaliacoes,
      congelarCabecalho: true,
    },
    { nome: "Resumo", larguras: [32, 12, 11], linhas: linhasResumo },
  ]);
}

// UMD manual — mesmo racional dos demais módulos.
const API_XLSX = { crc32, montarZip, gerarPasta, planilhaDeNotas, escaparXML, colunaLetra, ESTILOS };

if (typeof module !== "undefined" && module.exports) {
  module.exports = API_XLSX;
} else {
  globalThis.AdataXLSX = API_XLSX;
}
