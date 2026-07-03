/**
 * Testes de export.js — módulo puro, roda em Node sem Chrome API.
 * Foco no formato que o Excel pt-BR realmente abre como tabela.
 */

"use strict";

const { paraCSV, paraMarkdown, paraJSON, escaparCSV } = require("../src/export");

const atividade = (extra = {}) => ({
  uuid: "u1",
  titulo: "Atividade",
  semana: 2,
  eixo: "Computação",
  tipo: "Ponderada",
  professor: "Fulana",
  link: "https://exemplo.com",
  descricao: "Descrição simples",
  ...extra,
});

describe("paraCSV — formato Excel pt-BR", () => {
  test("começa com BOM UTF-8 (acentos corretos no Excel)", () => {
    expect(paraCSV([]).charCodeAt(0)).toBe(0xfeff);
  });

  test('separa colunas com ";" (separador de lista do locale pt-BR)', () => {
    const [cabecalho] = paraCSV([atividade()]).split("\r\n");
    expect(cabecalho).toBe("﻿uuid;titulo;semana;eixo;tipo;professor;link;descricao");
  });

  test("uma linha por atividade, colunas na ordem do cabeçalho", () => {
    const linhas = paraCSV([atividade()]).split("\r\n");
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toBe("u1;Atividade;2;Computação;Ponderada;Fulana;https://exemplo.com;Descrição simples");
  });

  test("célula com separador ou aspas vai entre aspas, com aspas dobradas", () => {
    const linhas = paraCSV([
      atividade({ descricao: 'Tem ; separador, "aspas" no meio' }),
    ]).split("\r\n");
    expect(linhas[1]).toContain('"Tem ; separador, ""aspas"" no meio"');
    expect(linhas).toHaveLength(2);
  });

  test("quebra de linha na descrição vira espaço: um registro = uma linha na planilha", () => {
    const csv = paraCSV([atividade({ descricao: "Primeiro parágrafo.\n\nSegundo parágrafo." })]);
    const linhas = csv.split("\r\n");
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain("Primeiro parágrafo. Segundo parágrafo.");
  });

  test("semana Infinity vira texto legível", () => {
    expect(paraCSV([atividade({ semana: Infinity })])).toContain(";sem semana;");
  });
});

describe("escaparCSV", () => {
  test("valor simples passa intacto", () => {
    expect(escaparCSV("abc")).toBe("abc");
  });
  test("null/undefined viram vazio", () => {
    expect(escaparCSV(null)).toBe("");
    expect(escaparCSV(undefined)).toBe("");
  });
});

describe("paraMarkdown", () => {
  test("agrupa por semana com cabeçalho ## e metadados por atividade", () => {
    const md = paraMarkdown([
      atividade({ semana: 1, titulo: "Primeira" }),
      atividade({ uuid: "u2", semana: 1, titulo: "Segunda" }),
      atividade({ uuid: "u3", semana: 3, titulo: "Terceira" }),
    ]);
    expect(md).toContain("## Semana 1");
    expect(md).toContain("## Semana 3");
    expect(md).toContain("### Primeira");
    expect(md).toContain("- **Eixo:** Computação");
    expect(md).toContain("- **Tipo:** Ponderada");
    // Só um cabeçalho para a semana 1, mesmo com duas atividades.
    expect(md.match(/## Semana 1/g)).toHaveLength(1);
  });
});

describe("paraJSON", () => {
  test("exporta campos normalizados sem o objeto bruto", () => {
    const dados = JSON.parse(paraJSON([atividade({ bruto: { pesado: true } })]));
    expect(dados).toHaveLength(1);
    expect(dados[0].uuid).toBe("u1");
    expect(dados[0].bruto).toBeUndefined();
    expect(dados[0].semana).toBe(2);
  });

  test("semana Infinity vira null (JSON não tem Infinity)", () => {
    const dados = JSON.parse(paraJSON([atividade({ semana: Infinity })]));
    expect(dados[0].semana).toBeNull();
  });
});
