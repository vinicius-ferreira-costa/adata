/**
 * Testes de normalize.js — módulo puro, roda em Node sem Chrome API.
 */

"use strict";

const {
  EIXOS_VALIDOS,
  chaveJuncao,
  limparHTML,
  resolverEixo,
  tipoDoCard,
  numeroSemana,
  normalizarAtividades,
} = require("../src/normalize");

describe("chaveJuncao", () => {
  test("minúsculo, sem acento, só alfanumérico", () => {
    expect(chaveJuncao("Ponderada 1 — Álgebra Linear!")).toBe("ponderada1algebralinear");
  });

  test("acentos removidos via NFD", () => {
    expect(chaveJuncao("Andréa Zotovici")).toBe(chaveJuncao("Andrea Zotovici"));
    expect(chaveJuncao("Matemática")).toBe("matematica");
  });

  test("entrada não-string vira string vazia", () => {
    expect(chaveJuncao(null)).toBe("");
    expect(chaveJuncao(42)).toBe("");
  });
});

describe("limparHTML", () => {
  test("remove tags e decodifica entidades comuns", () => {
    expect(limparHTML('<p>Olá <strong>mundo</strong>&nbsp;&amp; cia</p>')).toBe("Olá mundo & cia");
  });

  test("decodifica os acentos escapados que a Adalove manda (voc&ecirc; etc.)", () => {
    expect(limparHTML("Uma vez que voc&ecirc; tenha, voc&ecirc; precisar&aacute; organiz&aacute;-las"))
      .toBe("Uma vez que você tenha, você precisará organizá-las");
    expect(limparHTML("User Stories s&atilde;o a espinha; configura&ccedil;&atilde;o"))
      .toBe("User Stories são a espinha; configuração");
  });

  test("maiúscula inicial da entidade é respeitada (&Eacute; → É)", () => {
    expect(limparHTML("&Eacute; isso")).toBe("É isso");
  });

  test("entidades numéricas também decodificam", () => {
    expect(limparHTML("caf&#233; &#x2013; forte")).toBe("café – forte");
  });

  test("entidade desconhecida fica intacta (nunca corromper texto)", () => {
    expect(limparHTML("x &xptoinvalida; y")).toBe("x &xptoinvalida; y");
  });

  test("block tags viram quebra de linha (parágrafos sobrevivem no Markdown)", () => {
    expect(limparHTML("<p>Primeiro</p><p>Segundo</p>")).toBe("Primeiro\nSegundo");
  });

  test("texto sem HTML passa intacto", () => {
    expect(limparHTML("Texto puro, sem markup.")).toBe("Texto puro, sem markup.");
  });
});

describe("numeroSemana", () => {
  test('extrai inteiro de "Semana 09"', () => {
    expect(numeroSemana("Semana 09")).toBe(9);
  });

  test('extrai de "Semana 12"', () => {
    expect(numeroSemana("Semana 12")).toBe(12);
  });

  test("sem número retorna Infinity (vai para o fim da ordenação)", () => {
    expect(numeroSemana("Projeto Final")).toBe(Infinity);
    expect(numeroSemana("")).toBe(Infinity);
    expect(numeroSemana(undefined)).toBe(Infinity);
  });
});

describe("resolverEixo — cascata de três fontes", () => {
  test("1ª fonte: campo estruturado com eixo válido", () => {
    expect(resolverEixo({ eixo: "Computação" })).toBe("Computação");
    // Reconhece mesmo sem acento/caixa diferente.
    expect(resolverEixo({ axis: "matematica" })).toBe("Matemática");
  });

  test("1ª fonte: siglas reais da API em axisCaption (COM/MTF/NEG/UEX/LID)", () => {
    expect(resolverEixo({ axisCaption: "COM" })).toBe("Computação");
    expect(resolverEixo({ axisCaption: "MTF" })).toBe("Matemática");
    expect(resolverEixo({ axisCaption: "NEG" })).toBe("Negócios");
    expect(resolverEixo({ axisCaption: "UEX" })).toBe("Design");
    expect(resolverEixo({ axisCaption: "LID" })).toBe("Liderança");
  });

  test("axisCaption null (card sem eixo) cai para as fontes seguintes", () => {
    expect(resolverEixo({ axisCaption: null, professorName: "Vanessa Tavares Nunes" })).toBe("Liderança");
    expect(resolverEixo({ axisCaption: null })).toBe("Orientação");
  });

  test("campo estruturado com valor INVÁLIDO não é aceito — cai para o professor", () => {
    expect(
      resolverEixo({ eixo: "Categoria Interna XPTO", professorName: "Fernando Pizzo Ribeiro" })
    ).toBe("Matemática");
  });

  test("2ª fonte: mapa professor→eixo", () => {
    expect(resolverEixo({ professorName: "Andréa Zotovici" })).toBe("Computação");
    expect(resolverEixo({ professorName: "Vanessa Tavares Nunes" })).toBe("Liderança");
    // Sem acento também casa (chaves normalizadas).
    expect(resolverEixo({ professorName: "Fabio Cassio de Souza" })).toBe("Negócios");
  });

  test("orientadora fica fora do mapa: cards dela são Orientação, não Liderança", () => {
    expect(resolverEixo({ professorName: "Julia Stateri" })).toBe("Orientação");
  });

  test('3ª fonte: sem eixo → "Orientação", nunca chuta um dos cinco', () => {
    expect(resolverEixo({ professorName: "Professor Desconhecido" })).toBe("Orientação");
    expect(resolverEixo({})).toBe("Orientação");
    expect(resolverEixo({ axisCaption: null })).toBe("Orientação");
  });

  test("os cinco eixos válidos são exatamente os esperados", () => {
    expect(EIXOS_VALIDOS).toEqual(["Computação", "Design", "Matemática", "Liderança", "Negócios"]);
  });
});

describe("tipoDoCard — código type da API + peso", () => {
  test("type 11 é Autoestudo; com gradeWeight > 0 vira Ponderada", () => {
    expect(tipoDoCard({ type: 11, gradeWeight: 0 })).toBe("Autoestudo");
    expect(tipoDoCard({ type: 11, gradeWeight: 3 })).toBe("Ponderada");
  });

  test("type 21 é Artefato (entrega de projeto)", () => {
    expect(tipoDoCard({ type: 21, gradeWeight: 2 })).toBe("Artefato");
  });

  test("types 1 e 2 são Encontros", () => {
    expect(tipoDoCard({ type: 1 })).toBe("Encontro");
    expect(tipoDoCard({ type: 2 })).toBe("Encontro");
  });

  test("type desconhecido vira Outro — card nunca some por tipo novo", () => {
    expect(tipoDoCard({ type: 99 })).toBe("Outro");
    expect(tipoDoCard({})).toBe("Outro");
  });
});

describe("normalizarAtividades", () => {
  const base = (extra) => ({
    studentActivityUuid: "u1",
    title: "Atividade",
    folderCaption: "Semana 01",
    ...extra,
  });

  test("deduplica por studentActivityUuid — última ocorrência vence", () => {
    const resultado = normalizarAtividades([
      base({ title: "Versão antiga" }),
      base({ title: "Versão nova" }),
    ]);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].titulo).toBe("Versão nova");
  });

  test("ordena por semana e depois por título", () => {
    const resultado = normalizarAtividades([
      { studentActivityUuid: "a", title: "Zebra", folderCaption: "Semana 02" },
      { studentActivityUuid: "b", title: "Abelha", folderCaption: "Semana 02" },
      { studentActivityUuid: "c", title: "Primeiro", folderCaption: "Semana 01" },
      { studentActivityUuid: "d", title: "Sem semana" },
    ]);
    expect(resultado.map((a) => a.titulo)).toEqual(["Primeiro", "Abelha", "Zebra", "Sem semana"]);
    expect(resultado[3].semana).toBe(Infinity); // sem semana no fim
  });

  test("itens sem uuid identificável são descartados", () => {
    const resultado = normalizarAtividades([{ title: "Fantasma" }, base({})]);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].uuid).toBe("u1");
  });

  test("extrai campos normalizados e preserva o bruto", () => {
    const bruta = base({
      professorName: "Andréa Zotovici",
      link: "https://exemplo.com",
      description: "Descrição completa.",
    });
    const [atividade] = normalizarAtividades([bruta]);
    expect(atividade).toMatchObject({
      uuid: "u1",
      titulo: "Atividade",
      semana: 1,
      eixo: "Computação",
      professor: "Andréa Zotovici",
      link: "https://exemplo.com",
      descricao: "Descrição completa.",
    });
    expect(atividade.bruto).toBe(bruta);
  });

  test("entrada inválida retorna lista vazia", () => {
    expect(normalizarAtividades(null)).toEqual([]);
    expect(normalizarAtividades(undefined)).toEqual([]);
  });
});
