/**
 * Testes de xlsx.js — módulo puro, roda em Node sem Chrome API.
 *
 * Como as entradas do ZIP são "stored" (sem compressão), o conteúdo XML fica
 * legível dentro dos bytes: os testes procuram texto direto no buffer.
 */

"use strict";

const { crc32, montarZip, gerarPasta, planilhaDeNotas, escaparXML, colunaLetra, ESTILOS } =
  require("../src/xlsx");

const contras = (bytes, texto) => Buffer.from(bytes).includes(Buffer.from(texto, "utf8"));

describe("crc32", () => {
  test("valores de referência conhecidos", () => {
    expect(crc32(new TextEncoder().encode("abc"))).toBe(0x352441c2);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("colunaLetra", () => {
  test("converte índice em referência de coluna do Excel", () => {
    expect(colunaLetra(0)).toBe("A");
    expect(colunaLetra(25)).toBe("Z");
    expect(colunaLetra(26)).toBe("AA");
  });
});

describe("escaparXML", () => {
  test("escapa os caracteres reservados", () => {
    expect(escaparXML('A & B <c> "d"')).toBe("A &amp; B &lt;c&gt; &quot;d&quot;");
  });
});

describe("montarZip", () => {
  test("estrutura básica: assinaturas locais, diretório central e EOCD", () => {
    const zip = montarZip([{ nome: "a.txt", texto: "olá" }]);
    // Assinatura do primeiro cabeçalho local: PK\x03\x04.
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // EOCD nos últimos 22 bytes: PK\x05\x06 com contagem de 1 entrada.
    const eocd = zip.slice(zip.length - 22);
    expect([...eocd.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(eocd[8] | (eocd[9] << 8)).toBe(1); // entradas neste disco
    // Conteúdo em stored é legível.
    expect(contras(zip, "olá")).toBe(true);
  });
});

describe("gerarPasta", () => {
  const pasta = () =>
    gerarPasta([
      {
        nome: "Minha Aba",
        larguras: [10, 20],
        linhas: [
          [{ v: "Título & Cia", s: ESTILOS.CABECALHO }, { v: "B" }],
          [{ v: 9.5, n: true, s: ESTILOS.NUMERO }, { v: "texto <especial>" }],
        ],
        congelarCabecalho: true,
      },
    ]);

  test("contém as partes obrigatórias do pacote Open XML", () => {
    const bytes = pasta();
    for (const parte of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(contras(bytes, parte)).toBe(true);
    }
  });

  test("nome da aba, valores e escapes aparecem no XML", () => {
    const bytes = pasta();
    expect(contras(bytes, 'name="Minha Aba"')).toBe(true);
    expect(contras(bytes, "Título &amp; Cia")).toBe(true);
    expect(contras(bytes, "texto &lt;especial&gt;")).toBe(true);
    expect(contras(bytes, "<v>9.5</v>")).toBe(true);
    // Cabeçalho congelado.
    expect(contras(bytes, 'state="frozen"')).toBe(true);
  });
});

describe("planilhaDeNotas", () => {
  const avaliacoes = [
    { semana: 2, titulo: "Ponderada de Negócios", categoria: "Ponderada", eixo: "Negócios", peso: 2, nota: 9.6 },
    { semana: 8, titulo: "Prova final", categoria: "Ponderada", eixo: "Matemática", peso: 3, nota: null },
  ];
  const resumo = {
    turma: "2026-1B-T29",
    mediaAteOMomento: 9.6,
    mediaAcumulada: 3.84,
    mediaComFator: 8.53,
    categorias: { Ponderada: { media: 9.6, quantidade: 2 } },
    frequencia: { presencaPct: 99.3, faltas: 1, limite: 27, restantes: 26 },
  };

  test("gera as duas abas com dados, pendência destacada e resumo", () => {
    const bytes = planilhaDeNotas(avaliacoes, resumo);
    expect(contras(bytes, 'name="Avaliações"')).toBe(true);
    expect(contras(bytes, 'name="Resumo"')).toBe(true);
    expect(contras(bytes, "Ponderada de Negócios")).toBe(true);
    expect(contras(bytes, "Pendente")).toBe(true);
    expect(contras(bytes, "Média com fator (oficial Adalove)")).toBe(true);
    expect(contras(bytes, "Limite de faltas (20%)")).toBe(true);
    expect(contras(bytes, "sheet2.xml")).toBe(true);
  });

  test("sem frequência, a seção não aparece", () => {
    const bytes = planilhaDeNotas(avaliacoes, { ...resumo, frequencia: null });
    expect(contras(bytes, "Limite de faltas")).toBe(false);
  });
});
