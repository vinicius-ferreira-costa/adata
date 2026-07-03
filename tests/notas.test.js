/**
 * Testes de notas.js — módulo puro, roda em Node sem Chrome API.
 */

"use strict";

const {
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
  FAIXAS_PARTICIPACAO,
} = require("../src/notas");

const { chaveJuncao } = require("../src/normalize");

// Helper: avaliação no formato interno.
const av = (uuid, peso, nota, extras = {}) => ({
  uuid,
  titulo: extras.titulo ?? uuid,
  semana: extras.semana ?? 1,
  categoria: extras.categoria ?? "Ponderada",
  peso,
  nota,
});

describe("normalizarAvaliacoes", () => {
  test("extrai peso/nota, deduplica e ordena por semana", () => {
    const resultado = normalizarAvaliacoes([
      { studentActivityUuid: "b", title: "Prova 2", folderCaption: "Semana 08", weight: 2, grade: 7 },
      { studentActivityUuid: "a", title: "Prova 1", folderCaption: "Semana 02", weight: 1, grade: 9 },
      { studentActivityUuid: "a", title: "Prova 1 atualizada", folderCaption: "Semana 02", weight: 1, grade: 9.5 },
    ]);
    expect(resultado).toHaveLength(2);
    expect(resultado.map((a) => a.uuid)).toEqual(["a", "b"]); // ordenado por semana
    expect(resultado[0].nota).toBe(9.5); // última captura vence
  });

  test("nota ausente vira null (não lançada), peso ausente vira 1", () => {
    const [avaliacao] = normalizarAvaliacoes([
      { studentActivityUuid: "x", title: "Artefato", folderCaption: "Semana 03" },
    ]);
    expect(avaliacao.nota).toBeNull();
    expect(avaliacao.peso).toBe(1);
  });

  test('nota em string com vírgula ("8,5") é interpretada', () => {
    const [avaliacao] = normalizarAvaliacoes([
      { studentActivityUuid: "x", grade: "8,5", weight: "2" },
    ]);
    expect(avaliacao.nota).toBe(8.5);
    expect(avaliacao.peso).toBe(2);
  });

  // Casos do contrato REAL da API (observado em /sections/{uuid}/userdata):
  test("campos reais: gradeResult string + gradeWeight", () => {
    const [avaliacao] = normalizarAvaliacoes([
      { studentActivityUuid: "x", caption: "Ponderada de Negócios", gradeResult: "9.6", gradeWeight: 3, type: 11, folderCaption: "Semana 02" },
    ]);
    expect(avaliacao.nota).toBe(9.6);
    expect(avaliacao.peso).toBe(3);
    expect(avaliacao.titulo).toBe("Ponderada de Negócios");
    expect(avaliacao.semana).toBe(2);
  });

  test("gradeResult -1 (sentinela da API) vira null, não nota negativa", () => {
    const [avaliacao] = normalizarAvaliacoes([
      { studentActivityUuid: "x", gradeResult: -1, gradeWeight: 2 },
    ]);
    expect(avaliacao.nota).toBeNull();
  });

  test("cards com gradeWeight 0 (não valem nota) ficam de fora da lista", () => {
    const resultado = normalizarAvaliacoes([
      { studentActivityUuid: "a", caption: "Autoestudo comum", gradeWeight: 0, gradeResult: -1 },
      { studentActivityUuid: "b", caption: "Ponderada", gradeWeight: 3, gradeResult: "8.0" },
    ]);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].uuid).toBe("b");
  });

  test("categoria mapeada pelo código type da API (11/21/1/2)", () => {
    const resultado = normalizarAvaliacoes([
      { studentActivityUuid: "p", type: 11, gradeWeight: 3 },
      { studentActivityUuid: "art", type: 21, gradeWeight: 2 },
      { studentActivityUuid: "aula", type: 1, gradeWeight: 20 },
    ]);
    const porUuid = Object.fromEntries(resultado.map((a) => [a.uuid, a.categoria]));
    expect(porUuid.p).toBe("Ponderada");
    expect(porUuid.art).toBe("Artefato");
    expect(porUuid.aula).toBe("Aula");
  });
});

describe("médias ponderadas", () => {
  const avaliacoes = [
    av("a", 2, 8),    // 16
    av("b", 1, 5),    // 5
    av("c", 1, null), // não lançada
  ];

  test("média até o momento ignora notas não lançadas", () => {
    // (8*2 + 5*1) / (2+1) = 21/3 = 7
    expect(mediaAteOMomento(avaliacoes)).toBeCloseTo(7);
  });

  test("média acumulada trata não lançada como 0 sobre o peso total", () => {
    // (8*2 + 5*1 + 0*1) / (2+1+1) = 21/4 = 5.25
    expect(mediaAcumulada(avaliacoes)).toBeCloseTo(5.25);
  });

  test("sem nenhuma nota lançada, média até o momento é null (não 0)", () => {
    expect(mediaAteOMomento([av("a", 1, null)])).toBeNull();
    expect(mediaAteOMomento([])).toBeNull();
  });
});

describe("desempenhoPorCategoria", () => {
  test("agrupa e calcula média por categoria", () => {
    const resultado = desempenhoPorCategoria([
      av("a", 1, 8, { categoria: "Ponderada" }),
      av("b", 1, 6, { categoria: "Ponderada" }),
      av("c", 1, 10, { categoria: "Aula" }),
      av("d", 1, null, { categoria: "Artefato" }),
    ]);
    expect(resultado.Ponderada.media).toBeCloseTo(7);
    expect(resultado.Ponderada.quantidade).toBe(2);
    expect(resultado.Aula.media).toBeCloseTo(10);
    expect(resultado.Artefato.media).toBeNull(); // nada lançado ainda
  });
});

describe("aplicarParticipacao — faixas A a E", () => {
  test("faixas aplicam +5%/0%/−5%/−10%/−15%", () => {
    expect(aplicarParticipacao(8, "A")).toBeCloseTo(8.4);
    expect(aplicarParticipacao(8, "B")).toBeCloseTo(8);
    expect(aplicarParticipacao(8, "C")).toBeCloseTo(7.6);
    expect(aplicarParticipacao(8, "D")).toBeCloseTo(7.2);
    expect(aplicarParticipacao(8, "E")).toBeCloseTo(6.8);
  });

  test("resultado limitado ao teto 10", () => {
    expect(aplicarParticipacao(9.9, "A")).toBe(10);
  });

  test("média null passa direto (nada a ajustar)", () => {
    expect(aplicarParticipacao(null, "A")).toBeNull();
  });

  test("as cinco faixas existem com os percentuais esperados", () => {
    expect(FAIXAS_PARTICIPACAO).toEqual({ A: 0.05, B: 0, C: -0.05, D: -0.1, E: -0.15 });
  });
});

describe("simular — simulação direta", () => {
  const avaliacoes = [av("a", 2, 8), av("b", 1, null)];

  test("nota hipotética entra no cálculo", () => {
    const { mediaAcumulada: media } = simular(avaliacoes, { b: 10 });
    // (8*2 + 10*1) / 3 = 26/3
    expect(media).toBeCloseTo(26 / 3);
  });

  test("múltiplas alterações ao mesmo tempo", () => {
    const { mediaAcumulada: media } = simular(avaliacoes, { a: 10, b: 10 });
    expect(media).toBeCloseTo(10);
  });

  test("não muta a lista original", () => {
    simular(avaliacoes, { a: 0 });
    expect(avaliacoes[0].nota).toBe(8);
  });

  test("sem alterações devolve as médias reais", () => {
    const { mediaAcumulada: media } = simular(avaliacoes, {});
    expect(media).toBeCloseTo(16 / 3);
  });
});

describe("notaNecessaria — simulador reverso", () => {
  const avaliacoes = [av("a", 2, 8), av("b", 1, 5), av("c", 1, null)];
  // Peso total 4; soma dos outros (a, b) = 16 + 5 = 21.

  test("calcula a nota que fecha a média desejada", () => {
    // media 6 → nota = (6*4 - 21) / 1 = 3
    expect(notaNecessaria(avaliacoes, "c", 6)).toBeCloseTo(3);
  });

  test("consistência: aplicar a nota calculada atinge exatamente a média", () => {
    const necessaria = notaNecessaria(avaliacoes, "c", 7);
    const { mediaAcumulada: media } = simular(avaliacoes, { c: necessaria });
    expect(media).toBeCloseTo(7);
  });

  test("resultado acima de 10 sinaliza impossibilidade (não é truncado)", () => {
    // media 9.5 → nota = (9.5*4 - 21) / 1 = 17
    expect(notaNecessaria(avaliacoes, "c", 9.5)).toBeCloseTo(17);
  });

  test("resultado negativo sinaliza média já garantida", () => {
    expect(notaNecessaria(avaliacoes, "c", 5)).toBeLessThan(0);
  });

  test("peso considera a incógnita: alvo com peso maior pede nota menor", () => {
    const comPesoMaior = [av("a", 2, 8), av("b", 1, 5), av("c", 3, null)];
    // media 6 → nota = (6*6 - 21) / 3 = 5
    expect(notaNecessaria(comPesoMaior, "c", 6)).toBeCloseTo(5);
  });

  test("avaliação inexistente ou peso zero retorna null", () => {
    expect(notaNecessaria(avaliacoes, "nao-existe", 6)).toBeNull();
    expect(notaNecessaria([av("z", 0, null)], "z", 6)).toBeNull();
  });
});

describe("evolucaoPorSemana — curva da média acumulada", () => {
  test("cada semana com nota vira um ponto com a média acumulada até ali", () => {
    const curva = evolucaoPorSemana([
      av("a", 1, 10, { semana: 1 }),
      av("b", 1, 6, { semana: 2 }),
      av("c", 2, 8, { semana: 4 }),
    ]);
    expect(curva).toHaveLength(3);
    expect(curva[0]).toEqual({ semana: 1, media: 10 });
    expect(curva[1].media).toBeCloseTo(8); // (10+6)/2
    expect(curva[2].media).toBeCloseTo(8); // (10+6+16)/4
  });

  test("notas não lançadas e avaliações sem semana ficam fora da curva", () => {
    const curva = evolucaoPorSemana([
      av("a", 1, 8, { semana: 1 }),
      av("b", 1, null, { semana: 2 }),   // pendente: fora
      av("c", 1, 9, { semana: Infinity }), // sem semana: fora
    ]);
    expect(curva).toEqual([{ semana: 1, media: 8 }]);
  });

  test("lista vazia devolve curva vazia", () => {
    expect(evolucaoPorSemana([])).toEqual([]);
  });
});

describe("mediasDaSemana — média isolada de cada semana (barras do gráfico)", () => {
  test("cada semana só considera as notas lançadas nela", () => {
    const serie = mediasDaSemana([
      av("a", 1, 10, { semana: 1 }),
      av("b", 3, 6, { semana: 2 }),
      av("c", 1, 8, { semana: 2 }),
    ]);
    expect(serie).toHaveLength(2);
    expect(serie[0]).toEqual({ semana: 1, media: 10 });
    expect(serie[1].media).toBeCloseTo((6 * 3 + 8 * 1) / 4); // ponderada dentro da semana
  });

  test("mesmas semanas da curva acumulada (as duas séries andam juntas no gráfico)", () => {
    const avaliacoes = [
      av("a", 1, 7, { semana: 1 }),
      av("b", 1, null, { semana: 2 }), // pendente: fora das duas
      av("c", 1, 9, { semana: 3 }),
    ];
    const semanasBarras = mediasDaSemana(avaliacoes).map((p) => p.semana);
    const semanasLinha = evolucaoPorSemana(avaliacoes).map((p) => p.semana);
    expect(semanasBarras).toEqual(semanasLinha);
  });
});

describe("juntarComInstrucoes — junção nota↔instrução (v4.1)", () => {
  const instrucoes = [
    { uuid: "u1", titulo: "Ponderada de Álgebra", link: "https://l1", descricao: "Enunciado 1", eixo: "Matemática" },
    { uuid: "u9", titulo: "Guia de Estilo", link: "https://l2", descricao: "Enunciado 2", eixo: "Design" },
  ];

  test("1ª camada: casa por uuid (contrato atual — mesmo card)", () => {
    const [junta] = juntarComInstrucoes([av("u1", 2, 9)], instrucoes, chaveJuncao);
    expect(junta.link).toBe("https://l1");
    expect(junta.descricao).toBe("Enunciado 1");
    expect(junta.eixo).toBe("Matemática");
  });

  test("2ª camada: sem uuid comum, casa por título normalizado (acentos ignorados)", () => {
    const avaliacao = av("outro-uuid", 2, 9, { titulo: "PONDERADA DE ALGEBRA" });
    const [junta] = juntarComInstrucoes([avaliacao], instrucoes, chaveJuncao);
    expect(junta.link).toBe("https://l1");
  });

  test("sem casamento, campos ficam vazios (nunca inventa)", () => {
    const [junta] = juntarComInstrucoes([av("x", 1, 5, { titulo: "Sem par" })], instrucoes, chaveJuncao);
    expect(junta.link).toBe("");
    expect(junta.descricao).toBe("");
  });

  test("não muta a avaliação original", () => {
    const original = av("u1", 2, 9);
    juntarComInstrucoes([original], instrucoes, chaveJuncao);
    expect(original.link).toBeUndefined();
  });
});

describe("calcularFrequencia — attendance1..3 dos cards", () => {
  // Helper: card de encontro com três slots de check-in.
  const encontro = (a1, a2, a3) => ({ attendance1: a1, attendance2: a2, attendance3: a3 });

  test("conta check-ins, faltas e presenças (10=presente, 0=falta, -1=n/a)", () => {
    const freq = calcularFrequencia([
      encontro(10, 10, 10), // 3 presenças
      encontro(10, 0, 10),  // 1 falta
      encontro(-1, -1, -1), // não conta
      { caption: "card sem attendance" },
    ]);
    expect(freq.totalCheckins).toBe(6);
    expect(freq.presentes).toBe(5);
    expect(freq.faltas).toBe(1);
  });

  test("limite = 20% do total de check-ins (calibrado contra a Adalove: 135 → 27)", () => {
    // 45 encontros × 3 slots = 135 check-ins, como no módulo real observado.
    const cards = Array.from({ length: 45 }, () => encontro(10, 10, 10));
    const freq = calcularFrequencia(cards);
    expect(freq.totalCheckins).toBe(135);
    expect(freq.limite).toBe(27);
    expect(freq.restantes).toBe(27);
    expect(freq.diasRestantes).toBe(9); // 27 check-ins / 3 por dia
    expect(freq.valorCheckin).toBeCloseTo(0.74, 2); // 1/135 = 0,74%
  });

  test("faltas consomem a margem e podem estourar o limite", () => {
    // 10 encontros = 30 check-ins → limite floor(30*0.2) = 6.
    const cards = [
      ...Array.from({ length: 7 }, () => encontro(0, 10, 10)), // 7 faltas
      ...Array.from({ length: 3 }, () => encontro(10, 10, 10)),
    ];
    const freq = calcularFrequencia(cards);
    expect(freq.limite).toBe(6);
    expect(freq.faltas).toBe(7);
    expect(freq.restantes).toBe(0);
    expect(freq.estourou).toBe(true);
  });

  test("sem nenhum check-in nos dados retorna null (sem captura ainda)", () => {
    expect(calcularFrequencia([])).toBeNull();
    expect(calcularFrequencia([{ caption: "só instrução" }])).toBeNull();
    expect(calcularFrequencia(null)).toBeNull();
  });
});
