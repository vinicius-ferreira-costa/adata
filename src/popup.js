/**
 * popup.js — lógica da interface.
 *
 * Lê chrome.storage.local (preenchido pelo background), normaliza via os
 * módulos puros (AdataNormalize / AdataNotas / AdataExport, carregados como
 * <script> antes deste arquivo) e renderiza as duas abas.
 *
 * As capturas são separadas POR TURMA (ver background.js); o popup mostra
 * uma turma por vez, escolhida no seletor do cabeçalho. Sem essa separação
 * as médias de módulos diferentes se misturavam — bug observado ao vivo.
 *
 * Downloads são feitos com Blob + URL.createObjectURL + <a download>
 * temporário: dispensa a permissão "downloads" no manifest, o que reduz o
 * atrito na revisão da Chrome Web Store e a superfície de permissões.
 */

"use strict";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const estado = {
  capturas: {},         // storage cru: { [sectionUuid]: { rotulo, atividades, statusAluno, ultimaCaptura } }
  turmaAtiva: null,     // sectionUuid selecionado
  autoestudos: [],      // cards normalizados da turma ativa (AdataNormalize)
  avaliacoes: [],       // avaliações normalizadas da turma ativa (AdataNotas)
  simulacao: {},        // uuid → nota hipotética digitada pelo aluno
};

const $ = (id) => document.getElementById(id);

/** Dados crus (brutos) da turma ativa; base de tudo que as abas mostram. */
function turmaAtual() {
  return estado.capturas[estado.turmaAtiva] || null;
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------

function trocarAba(qual) {
  const ehAutoestudos = qual === "autoestudos";
  $("aba-autoestudos").classList.toggle("ativa", ehAutoestudos);
  $("aba-notas").classList.toggle("ativa", !ehAutoestudos);
  $("aba-autoestudos").setAttribute("aria-selected", String(ehAutoestudos));
  $("aba-notas").setAttribute("aria-selected", String(!ehAutoestudos));
  $("painel-autoestudos").classList.toggle("oculto", !ehAutoestudos);
  $("painel-notas").classList.toggle("oculto", ehAutoestudos);
}

$("aba-autoestudos").addEventListener("click", () => trocarAba("autoestudos"));
$("aba-notas").addEventListener("click", () => trocarAba("notas"));

// ---------------------------------------------------------------------------
// Seletor de turma
// ---------------------------------------------------------------------------

function montarSeletorTurma() {
  const seletor = $("seletor-turma");
  seletor.innerHTML = "";
  // Ordena pela captura mais recente: a turma que o aluno está cursando
  // aparece primeiro no seletor.
  const turmas = Object.entries(estado.capturas).sort(
    (a, b) => (b[1].ultimaCaptura || 0) - (a[1].ultimaCaptura || 0)
  );
  for (const [uuid, turma] of turmas) {
    const opcao = document.createElement("option");
    opcao.value = uuid;
    opcao.textContent = turma.rotulo || uuid.slice(0, 8);
    seletor.appendChild(opcao);
  }
  if (estado.turmaAtiva) seletor.value = estado.turmaAtiva;
  seletor.classList.toggle("oculto", turmas.length === 0);
}

$("seletor-turma").addEventListener("change", () => {
  estado.turmaAtiva = $("seletor-turma").value;
  estado.simulacao = {}; // simulação é por turma; trocar de turma limpa
  renderizarTudo();
});

// ---------------------------------------------------------------------------
// Aba Autoestudos
// ---------------------------------------------------------------------------

function valoresMarcados(idContainer) {
  return [...document.querySelectorAll(`#${idContainer} input:checked`)].map((c) => c.value);
}

/** Aplica busca + filtros de eixo, tipo e semana sobre os cards da turma. */
function atividadesFiltradas() {
  const eixos = new Set(valoresMarcados("filtro-eixos"));
  const tipos = new Set(valoresMarcados("filtro-tipos"));
  const semana = $("filtro-semana").value;
  const termo = $("busca").value.trim().toLowerCase();

  return estado.autoestudos.filter((a) => {
    if (!eixos.has(a.eixo)) return false;
    if (!tipos.has(a.tipo)) return false;
    if (semana !== "" && String(a.semana) !== semana) return false;
    if (termo && !(a.titulo.toLowerCase().includes(termo) || a.descricao.toLowerCase().includes(termo))) {
      return false;
    }
    return true;
  });
}

/** Gera checkboxes (todos marcados) num container; qualquer mudança re-renderiza. */
function montarCheckboxes(idContainer, opcoes) {
  const caixa = $(idContainer);
  caixa.innerHTML = "";
  for (const valor of opcoes) {
    const rotulo = document.createElement("label");
    const caixinha = document.createElement("input");
    caixinha.type = "checkbox";
    caixinha.value = valor;
    caixinha.checked = true; // todos marcados por padrão = exporta tudo
    caixinha.addEventListener("change", renderizarAutoestudos);
    rotulo.append(caixinha, document.createTextNode(valor));
    caixa.appendChild(rotulo);
  }
}

function montarFiltros() {
  // "Orientação" entra junto dos cinco eixos: é o balde dos cards sem
  // axisCaption (sprint review, workshops, encontros com a orientadora).
  montarCheckboxes("filtro-eixos", [...AdataNormalize.EIXOS_VALIDOS, AdataNormalize.EIXO_SEM_EIXO]);
  // Só os tipos presentes na turma — checkbox de tipo inexistente é ruído.
  const tiposPresentes = AdataNormalize.TIPOS_CARD.filter((t) =>
    estado.autoestudos.some((a) => a.tipo === t)
  );
  montarCheckboxes("filtro-tipos", tiposPresentes.length ? tiposPresentes : AdataNormalize.TIPOS_CARD);

  const seletor = $("filtro-semana");
  const semanas = [...new Set(estado.autoestudos.map((a) => a.semana))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  seletor.innerHTML = '<option value="">Todas</option>';
  for (const semana of semanas) {
    const opcao = document.createElement("option");
    opcao.value = String(semana);
    opcao.textContent = `Semana ${semana}`;
    seletor.appendChild(opcao);
  }
}

$("filtro-semana").addEventListener("change", () => renderizarAutoestudos());
$("busca").addEventListener("input", () => renderizarAutoestudos());

function renderizarAutoestudos() {
  const filtradas = atividadesFiltradas();
  const lista = $("lista-atividades");
  lista.innerHTML = "";

  for (const atividade of filtradas) {
    const item = document.createElement("li");

    const badgeSemana = document.createElement("span");
    badgeSemana.className = "badge";
    badgeSemana.textContent = Number.isFinite(atividade.semana) ? `S${atividade.semana}` : "S?";

    const titulo = document.createElement("span");
    titulo.className = "item-titulo";
    titulo.textContent = atividade.titulo || "(sem título)";
    titulo.title = `${atividade.titulo}\n${atividade.tipo} · ${atividade.eixo}`;

    const badgeTipo = document.createElement("span");
    badgeTipo.className = "badge";
    badgeTipo.textContent = atividade.tipo;

    const badgeEixo = document.createElement("span");
    badgeEixo.className = "badge";
    badgeEixo.textContent = atividade.eixo;

    item.append(badgeSemana, titulo, badgeTipo, badgeEixo);
    lista.appendChild(item);
  }

  $("vazio-autoestudos").classList.toggle("oculto", estado.autoestudos.length > 0);
  $("contador-atividades").textContent = String(estado.autoestudos.length);
  $("contador-filtrados").textContent = String(filtradas.length);
}

// --- Frequência --------------------------------------------------------------

function renderizarFrequencia() {
  const cartao = $("cartao-frequencia");
  const turma = turmaAtual();
  const freq = turma
    ? AdataNotas.calcularFrequencia(Object.values(turma.atividades || {}))
    : null;

  cartao.classList.toggle("oculto", !freq);
  if (!freq) return;

  // Nível de risco pela fração da MARGEM já consumida (faltas ÷ limite),
  // não pela presença absoluta: 95% de presença parece confortável, mas se
  // o limite é 20%, pode ser 3/4 da margem já gasta.
  const fracaoUsada = freq.limite > 0 ? freq.faltas / freq.limite : freq.faltas > 0 ? 1 : 0;
  const nivel = freq.estourou || fracaoUsada >= 0.8 ? "risco" : fracaoUsada >= 0.5 ? "alerta" : "ok";

  const presencaPct = 100 - freq.percentualFaltas;
  const percentual = $("freq-percentual");
  percentual.textContent = `${presencaPct.toFixed(1)}%`;
  percentual.className = `freq-percentual ${nivel}`;

  const barra = $("freq-barra-preenchida");
  barra.style.width = `${Math.max(0, Math.min(100, presencaPct))}%`;
  barra.className = nivel; // verde → âmbar → vermelho conforme a margem some

  $("freq-resumo").textContent = freq.estourou
    ? `Limite de faltas ultrapassado (${freq.faltas} de ${freq.limite} permitidas).`
    : `Margem para ${freq.restantes} check-in(s) — cerca de ${freq.diasRestantes} dia(s) de aula. ` +
      `Cada check-in pesa ${freq.valorCheckin.toFixed(2)}% da presença.`;

  // Aviso escalonado: aparece quando metade da margem já foi consumida.
  const aviso = $("freq-aviso");
  if (freq.estourou) {
    aviso.textContent = "🚨 Você ultrapassou o limite de 20% de faltas do módulo.";
  } else if (fracaoUsada >= 0.8) {
    aviso.textContent =
      `🚨 Restam só ${freq.restantes} check-in(s) de margem — o limite é 20% de faltas.`;
  } else if (fracaoUsada >= 0.5) {
    aviso.textContent =
      `⚠ Você já usou ${Math.round(fracaoUsada * 100)}% da sua margem de faltas ` +
      `(máximo permitido: 20% dos check-ins).`;
  } else {
    aviso.textContent = "";
  }
  aviso.className = `freq-aviso ${nivel}` + (aviso.textContent === "" ? " oculto" : "");

  $("freq-faltas").textContent = String(freq.faltas);
  $("freq-limite").textContent = String(freq.limite);
  $("freq-restantes").textContent = String(freq.restantes);
}

// --- Exportação --------------------------------------------------------------

/**
 * Download sem a permissão "downloads": cria um Blob, um object URL e um
 * <a download> temporário. O revokeObjectURL evita vazar memória a cada
 * exportação.
 */
function baixarArquivo(nome, conteudo, mime) {
  const blob = new Blob([conteudo], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  link.click();
  URL.revokeObjectURL(url);
}

/** Nome de arquivo com o rótulo da turma — exportações de módulos não se sobrescrevem. */
function nomeArquivo(extensao) {
  const turma = turmaAtual();
  const rotulo = (turma && turma.rotulo ? turma.rotulo : "adata").replace(/[^\w-]+/g, "-");
  return `adata-${rotulo}.${extensao}`;
}

$("botao-csv").addEventListener("click", () => {
  baixarArquivo(nomeArquivo("csv"), AdataExport.paraCSV(atividadesFiltradas()), "text/csv");
});

$("botao-markdown").addEventListener("click", () => {
  baixarArquivo(nomeArquivo("md"), AdataExport.paraMarkdown(atividadesFiltradas()), "text/markdown");
});

$("botao-json").addEventListener("click", () => {
  baixarArquivo(nomeArquivo("json"), AdataExport.paraJSON(atividadesFiltradas()), "application/json");
});

$("botao-copiar").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(AdataExport.paraMarkdown(atividadesFiltradas()));
    const aviso = $("aviso-copiado");
    aviso.classList.remove("oculto");
    setTimeout(() => aviso.classList.add("oculto"), 1500);
  } catch (erro) {
    console.error("[Adata] Falha ao copiar:", erro);
  }
});

// ---------------------------------------------------------------------------
// Aba Notas
// ---------------------------------------------------------------------------

function formatarMedia(valor) {
  return valor === null || valor === undefined ? "—" : valor.toFixed(2);
}

/**
 * Máscara de nota sobre um <input type="text">.
 *
 * Por que NÃO type="number": o input numérico do Chrome ignora a tecla de
 * vírgula em várias combinações de locale (o aluno não conseguia digitar
 * "8,7") e a validação anterior clampava "11" para 10 no meio da digitação.
 *
 * Regras da máscara, aplicadas a cada tecla:
 *   - só dígitos e UMA vírgula (ponto vira vírgula);
 *   - no máximo 1 casa decimal — nota real tem formato "8,7";
 *   - se o número passar de 10, DERRUBA o último caractere digitado em vez
 *     de saltar para 10: quem digitou "8" e depois "7" sem vírgula vê "8"
 *     de volta e entende que faltou a vírgula.
 *
 * @returns {number|null} nota válida (0–10, 1 casa) ou null (campo vazio).
 */
function lerNotaDoCampo(campo) {
  let texto = campo.value
    .replace(/\./g, ",")
    .replace(/[^\d,]/g, "");

  // Uma vírgula só: da segunda em diante, descarta.
  const primeiraVirgula = texto.indexOf(",");
  if (primeiraVirgula !== -1) {
    texto =
      texto.slice(0, primeiraVirgula + 1) +
      texto.slice(primeiraVirgula + 1).replace(/,/g, "").slice(0, 1); // 1 casa decimal
  }

  // Acima de 10: remove do fim até caber (nunca "pula" para 10 sozinho).
  const valorDe = (t) => parseFloat(t.replace(",", "."));
  while (texto && Number.isFinite(valorDe(texto)) && valorDe(texto) > 10) {
    texto = texto.slice(0, -1);
  }

  if (campo.value !== texto) campo.value = texto;

  const nota = valorDe(texto);
  return Number.isFinite(nota) ? Math.min(10, Math.max(0, nota)) : null;
}

/**
 * Métricas oficiais capturadas do studentStatus da API: são o que a própria
 * Adalove calculou (média com fator, % de faltas, aprovado/reprovado).
 * Exibidas como fonte de verdade; o simulador local serve para cenários.
 */
function renderizarStatusOficial() {
  const caixa = $("status-oficial");
  caixa.innerHTML = "";
  const turma = turmaAtual();
  const statusAluno = turma && turma.statusAluno;
  if (!statusAluno) return;

  const partes = [];
  if (statusAluno.studentStatus) partes.push(`Status: ${statusAluno.studentStatus}`);
  if (statusAluno.absencesPercentage !== undefined) {
    partes.push(`Faltas: ${statusAluno.absencesPercentage}%`);
  }
  if (statusAluno.doneEvaluateResultFactor) {
    partes.push(`Média com fator: ${statusAluno.doneEvaluateResultFactor}`);
  }
  caixa.textContent = partes.join(" · ");
}

function renderizarMedias() {
  // As médias exibidas SEMPRE consideram a simulação em curso: é o ponto da
  // feature — digitar uma nota hipotética e ver a média mudar na hora.
  const { mediaAcumulada, mediaAteOMomento } = AdataNotas.simular(estado.avaliacoes, estado.simulacao);

  $("media-momento").textContent = formatarMedia(mediaAteOMomento);
  $("media-acumulada").textContent = formatarMedia(mediaAcumulada);

  const faixa = $("faixa-participacao").value;
  $("media-participacao").textContent = formatarMedia(
    AdataNotas.aplicarParticipacao(mediaAcumulada, faixa)
  );

  const temSimulacao = Object.keys(estado.simulacao).length > 0;
  $("botao-limpar-simulacao").classList.toggle("oculto", !temSimulacao);
}

function renderizarCategorias() {
  const desempenho = AdataNotas.desempenhoPorCategoria(estado.avaliacoes);
  const caixa = $("categorias");
  caixa.innerHTML = "";
  for (const categoria of [...AdataNotas.CATEGORIAS, "Outros"]) {
    const dados = desempenho[categoria];
    if (!dados) continue;
    const bloco = document.createElement("div");
    bloco.className = "categoria";
    const media = document.createElement("strong");
    media.textContent = formatarMedia(dados.media);
    bloco.append(media, document.createTextNode(`${categoria} (${dados.quantidade})`));
    caixa.appendChild(bloco);
  }
}

function renderizarAvaliacoes() {
  const lista = $("lista-avaliacoes");
  lista.innerHTML = "";

  // Junção nota↔instrução (v4.1): cada avaliação ganha link/descrição/eixo
  // do seu card de instrução (uuid primeiro, chaveJuncao como fallback).
  const enriquecidas = AdataNotas.juntarComInstrucoes(
    estado.avaliacoes,
    estado.autoestudos,
    AdataNormalize.chaveJuncao
  );

  // normalizarAvaliacoes já devolve ordenado por semana — a lista aparece na
  // ordem do módulo, sem o aluno ter que caçar a atividade certa.
  for (const avaliacao of enriquecidas) {
    const item = document.createElement("li");

    const badgeSemana = document.createElement("span");
    badgeSemana.className = "badge";
    badgeSemana.textContent = Number.isFinite(avaliacao.semana) ? `S${avaliacao.semana}` : "S?";

    const titulo = document.createElement("span");
    titulo.className = "item-titulo";
    titulo.textContent = avaliacao.titulo || "(sem título)";
    // A descrição casada vai no tooltip: enunciado à mão sem inchar a lista.
    titulo.title =
      `${avaliacao.titulo} — ${avaliacao.eixo || "?"} · categoria ${avaliacao.categoria}, peso ${avaliacao.peso}` +
      (avaliacao.descricao ? `\n\n${avaliacao.descricao.slice(0, 400)}` : "");

    const badgePeso = document.createElement("span");
    badgePeso.className = "badge";
    badgePeso.textContent = `peso ${avaliacao.peso}`;

    item.append(badgeSemana, titulo, badgePeso);
    // Sem link clicável aqui de propósito: o único URL que a API expõe
    // (basicActivityURL) aponta para o MATERIAL do autoestudo no site do
    // Inteli, não para o card da ponderada — o card é rota interna da SPA
    // sem URL pública. O material continua disponível nas exportações.

    // Nota ainda não lançada ganha destaque: é a que o aluno quer simular.
    if (avaliacao.nota === null) {
      const pendente = document.createElement("span");
      pendente.className = "badge pendente";
      pendente.textContent = "pendente";
      item.appendChild(pendente);
    }

    // Campo editável: valor real quando existe, vazio quando não lançada.
    // Editar cria uma entrada em estado.simulacao (nunca muta a avaliação).
    // type="text" + inputmode="decimal" + máscara própria (lerNotaDoCampo):
    // o type="number" engolia a vírgula em alguns locales.
    const campoNota = document.createElement("input");
    campoNota.type = "text";
    campoNota.inputMode = "decimal";
    campoNota.maxLength = 4; // "10," é o maior texto válido no meio da digitação
    campoNota.className = "item-nota";
    campoNota.placeholder = "—";
    const simulada = Object.prototype.hasOwnProperty.call(estado.simulacao, avaliacao.uuid);
    const notaExibida = simulada ? estado.simulacao[avaliacao.uuid] : avaliacao.nota;
    campoNota.value = notaExibida === null ? "" : String(notaExibida).replace(".", ",");
    campoNota.classList.toggle("nota-simulada", simulada);

    campoNota.addEventListener("input", () => {
      const valor = lerNotaDoCampo(campoNota);
      if (valor !== null) {
        estado.simulacao[avaliacao.uuid] = valor;
      } else {
        delete estado.simulacao[avaliacao.uuid]; // campo esvaziado = desfaz
      }
      campoNota.classList.toggle(
        "nota-simulada",
        Object.prototype.hasOwnProperty.call(estado.simulacao, avaliacao.uuid)
      );
      renderizarMedias();
      renderizarReverso();
    });

    item.appendChild(campoNota);
    lista.appendChild(item);
  }

  $("vazio-notas").classList.toggle("oculto", estado.avaliacoes.length > 0);
}

// --- Gráfico de evolução -----------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function elementoSVG(tag, atributos) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [nome, valor] of Object.entries(atributos)) el.setAttribute(nome, String(valor));
  return el;
}

/**
 * Gráfico combinado, em SVG puro (sem lib — vanilla por requisito do
 * projeto e para não inchar a extensão):
 *   - BARRAS com gradiente: média ponderada das notas lançadas NAQUELA
 *     semana ("como foi a semana");
 *   - LINHA com pontos: média acumulada até cada semana ("como a média
 *     caminhou").
 * As duas séries compartilham as mesmas semanas por construção (ambas só
 * consideram semanas com nota lançada).
 *
 * Escala Y fixa 0–10: a régua de notas é essa; escala automática esconderia
 * a distância real até a média mínima. Eixo X categórico (slots com o mesmo
 * espaçamento, não proporcional ao nº da semana): barras precisam de
 * largura constante para ficarem legíveis.
 */
function renderizarGrafico() {
  const acumulada = AdataNotas.evolucaoPorSemana(estado.avaliacoes);
  const daSemana = AdataNotas.mediasDaSemana(estado.avaliacoes);
  const bloco = $("bloco-grafico");
  // Com menos de 2 semanas não há evolução a mostrar; escondemos o bloco.
  bloco.classList.toggle("oculto", acumulada.length < 2);
  const caixa = $("grafico-evolucao");
  caixa.innerHTML = "";
  if (acumulada.length < 2) return;

  const LARGURA = 380;
  const ALTURA = 150;
  const MARGEM = { esquerda: 26, direita: 8, topo: 14, base: 18 };
  const larguraUtil = LARGURA - MARGEM.esquerda - MARGEM.direita;
  const alturaUtil = ALTURA - MARGEM.topo - MARGEM.base;

  // Slots categóricos: semana i ocupa o i-ésimo slot.
  const slot = larguraUtil / daSemana.length;
  const larguraBarra = Math.min(28, slot * 0.55);
  const xCentro = (indice) => MARGEM.esquerda + slot * indice + slot / 2;
  const y = (media) => MARGEM.topo + (1 - media / 10) * alturaUtil;

  const svg = elementoSVG("svg", { viewBox: `0 0 ${LARGURA} ${ALTURA}`, role: "img" });

  // Gradiente das barras (stop-color herda o accent via CSS custom property).
  const defs = document.createElementNS(SVG_NS, "defs");
  const gradiente = elementoSVG("linearGradient", { id: "adata-grad", x1: 0, y1: 0, x2: 0, y2: 1 });
  const stopTopo = elementoSVG("stop", { offset: "0%", class: "grad-topo" });
  const stopBase = elementoSVG("stop", { offset: "100%", class: "grad-base" });
  gradiente.append(stopTopo, stopBase);
  defs.appendChild(gradiente);
  svg.appendChild(defs);

  // Grade horizontal discreta com rótulos (0, 2.5, 5, 7.5, 10).
  for (const nivel of [0, 2.5, 5, 7.5, 10]) {
    svg.appendChild(
      elementoSVG("line", {
        class: "grade",
        x1: MARGEM.esquerda, y1: y(nivel),
        x2: LARGURA - MARGEM.direita, y2: y(nivel),
      })
    );
    const rotulo = elementoSVG("text", { class: "rotulo", x: 2, y: y(nivel) + 3 });
    rotulo.textContent = Number.isInteger(nivel) ? String(nivel) : nivel.toFixed(1);
    svg.appendChild(rotulo);
  }

  // Barras: média da semana, topo arredondado. Os rótulos de valor são
  // guardados e desenhados DEPOIS da linha — SVG pinta na ordem do DOM, e
  // desenhá-los agora deixaria a linha da acumulada por cima, escondendo
  // valores que caem perto dela (era o caso do "7.5").
  const rotulosDeValor = [];
  daSemana.forEach((ponto, indice) => {
    const altura = Math.max(2, y(0) - y(ponto.media));
    const barra = elementoSVG("rect", {
      class: "barra",
      x: xCentro(indice) - larguraBarra / 2,
      y: y(ponto.media),
      width: larguraBarra,
      height: altura,
      rx: 4,
    });
    const dica = document.createElementNS(SVG_NS, "title");
    dica.textContent = `Semana ${ponto.semana} — média da semana: ${ponto.media.toFixed(2)}`;
    barra.appendChild(dica);
    svg.appendChild(barra);

    const valor = elementoSVG("text", {
      class: "rotulo valor-barra",
      x: xCentro(indice),
      y: y(ponto.media) - 5,
      "text-anchor": "middle",
    });
    valor.textContent = ponto.media.toFixed(1);
    rotulosDeValor.push(valor);

    const semana = elementoSVG("text", {
      class: "rotulo",
      x: xCentro(indice),
      y: ALTURA - 4,
      "text-anchor": "middle",
    });
    semana.textContent = `S${ponto.semana}`;
    svg.appendChild(semana);
  });

  // Linha da acumulada por cima das barras, com pontos destacados.
  svg.appendChild(
    elementoSVG("polyline", {
      class: "linha",
      points: acumulada.map((p, i) => `${xCentro(i)},${y(p.media)}`).join(" "),
    })
  );
  acumulada.forEach((ponto, indice) => {
    const circulo = elementoSVG("circle", {
      class: "ponto",
      cx: xCentro(indice),
      cy: y(ponto.media),
      r: 3.5,
    });
    const dica = document.createElementNS(SVG_NS, "title");
    dica.textContent = `Semana ${ponto.semana} — média acumulada: ${ponto.media.toFixed(2)}`;
    circulo.appendChild(dica);
    svg.appendChild(circulo);
  });

  // Rótulos de valor por último: ficam acima de tudo, e o halo (stroke da
  // cor do fundo, via CSS paint-order) garante leitura mesmo cruzando a linha.
  for (const rotulo of rotulosDeValor) svg.appendChild(rotulo);

  caixa.appendChild(svg);

  // Legenda em HTML (mais nítida que texto SVG em popup pequeno).
  const legenda = document.createElement("div");
  legenda.className = "legenda-grafico";
  legenda.innerHTML =
    '<span><i class="amostra-barra"></i>média da semana</span>' +
    '<span><i class="amostra-linha"></i>média acumulada</span>';
  caixa.appendChild(legenda);
}

// --- Planilha .xlsx da aba Notas ---------------------------------------------

$("botao-xlsx").addEventListener("click", () => {
  // O xlsx.js só formata; os números saem daqui, calculados pelos módulos
  // puros — a planilha reflete os dados REAIS (sem a simulação em curso,
  // que é hipótese, não registro).
  const enriquecidas = AdataNotas.juntarComInstrucoes(
    estado.avaliacoes,
    estado.autoestudos,
    AdataNormalize.chaveJuncao
  );

  const turma = turmaAtual();
  const statusAluno = turma && turma.statusAluno;
  const freq = turma
    ? AdataNotas.calcularFrequencia(Object.values(turma.atividades || {}))
    : null;

  const bytes = AdataXLSX.planilhaDeNotas(enriquecidas, {
    turma: turma && turma.rotulo,
    mediaAteOMomento: AdataNotas.mediaAteOMomento(estado.avaliacoes),
    mediaAcumulada: AdataNotas.mediaAcumulada(estado.avaliacoes),
    mediaComFator:
      statusAluno && statusAluno.doneEvaluateResultFactor
        ? parseFloat(statusAluno.doneEvaluateResultFactor)
        : null,
    categorias: AdataNotas.desempenhoPorCategoria(estado.avaliacoes),
    frequencia: freq
      ? {
          presencaPct: Math.round((100 - freq.percentualFaltas) * 10) / 10,
          faltas: freq.faltas,
          limite: freq.limite,
          restantes: freq.restantes,
        }
      : null,
  });

  baixarArquivo(
    nomeArquivo("xlsx").replace("adata-", "adata-notas-"),
    bytes,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
});

$("botao-limpar-simulacao").addEventListener("click", () => {
  estado.simulacao = {};
  renderizarAvaliacoes();
  renderizarMedias();
  renderizarReverso();
});

$("faixa-participacao").addEventListener("change", renderizarMedias);

// --- Simulador reverso -----------------------------------------------------

function montarReverso() {
  const seletor = $("reverso-atividade");
  seletor.innerHTML = "";
  for (const avaliacao of estado.avaliacoes) {
    const opcao = document.createElement("option");
    opcao.value = avaliacao.uuid;
    const semana = Number.isFinite(avaliacao.semana) ? `S${avaliacao.semana} — ` : "";
    opcao.textContent = `${semana}${avaliacao.titulo || "(sem título)"}`;
    seletor.appendChild(opcao);
  }
}

$("reverso-atividade").addEventListener("change", () => renderizarReverso());
$("reverso-media").addEventListener("input", () => {
  lerNotaDoCampo($("reverso-media")); // mesma trava 0–10 do campo de simulação
  renderizarReverso();
});

function renderizarReverso() {
  const saida = $("reverso-resultado");
  const uuidAlvo = $("reverso-atividade").value;
  // Vírgula é o separador que o aluno digita; parseFloat só entende ponto.
  const mediaDesejada = parseFloat($("reverso-media").value.replace(",", "."));

  if (!uuidAlvo || !Number.isFinite(mediaDesejada)) {
    saida.textContent = "";
    return;
  }

  // O reverso considera a simulação em curso: "se eu tirar X naquela outra,
  // quanto preciso nesta?" é exatamente o fluxo de fim de módulo.
  const avaliacoesSimuladas = estado.avaliacoes.map((a) =>
    Object.prototype.hasOwnProperty.call(estado.simulacao, a.uuid)
      ? { ...a, nota: estado.simulacao[a.uuid] }
      : a
  );
  const necessaria = AdataNotas.notaNecessaria(avaliacoesSimuladas, uuidAlvo, mediaDesejada);

  saida.classList.remove("impossivel", "garantido");
  if (necessaria === null) {
    saida.textContent = "Não dá para calcular (peso zero?).";
  } else if (necessaria > 10) {
    saida.textContent = `Precisaria de ${necessaria.toFixed(2)} — impossível mesmo gabaritando.`;
    saida.classList.add("impossivel");
  } else if (necessaria <= 0) {
    saida.textContent = "Já garantido — qualquer nota fecha essa média.";
    saida.classList.add("garantido");
  } else {
    saida.textContent = `Você precisa tirar ${necessaria.toFixed(2)}.`;
  }
}

// ---------------------------------------------------------------------------
// Carga e render geral
// ---------------------------------------------------------------------------

function renderizarTudo() {
  const turma = turmaAtual();
  const cruas = turma ? Object.values(turma.atividades || {}) : [];

  estado.autoestudos = AdataNormalize.normalizarAtividades(cruas);
  // A MESMA lista alimenta as notas: normalizarAvaliacoes filtra quem tem
  // gradeWeight > 0. Uma fonte única elimina a classificação duplicada que
  // causava o bug de abas vazias.
  estado.avaliacoes = AdataNotas.normalizarAvaliacoes(cruas);

  if (turma && turma.ultimaCaptura) {
    $("ultima-captura").textContent =
      "última captura: " + new Date(turma.ultimaCaptura).toLocaleString("pt-BR");
  } else {
    $("ultima-captura").textContent = "";
  }

  montarFiltros();
  renderizarFrequencia();
  renderizarAutoestudos();

  renderizarStatusOficial();
  renderizarAvaliacoes();
  renderizarMedias();
  renderizarCategorias();
  renderizarGrafico();
  montarReverso();
  renderizarReverso();
}

/**
 * Autodiagnóstico. Dois problemas que o aluno não consegue distinguir
 * sozinho ("a extensão não puxa nada"):
 *   1. Worker de versão ANTIGA ainda rodando após atualizar os arquivos sem
 *      recarregar a extensão — grava no formato velho, popup lê o novo.
 *   2. Worker novo de pé, mas nenhuma captura ainda (falta navegar na
 *      Adalove).
 * O ping ao worker + a detecção de chaves do formato antigo separam os dois
 * casos e dizem exatamente o que fazer.
 */
async function diagnosticar() {
  const saida = $("diagnostico");

  // Chaves do formato antigo presentes = worker antigo escreveu depois da
  // atualização dos arquivos (o novo as removeria na migração).
  const legado = await chrome.storage.local.get(["autoestudos", "notas"]);
  const temLegado =
    Object.keys(legado.autoestudos || {}).length > 0 || Object.keys(legado.notas || {}).length > 0;

  const pong = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "ADATA_PING" }, (resposta) => {
        void chrome.runtime.lastError;
        resolve(resposta || null);
      });
    } catch {
      resolve(null);
    }
  });

  if (!pong || !pong.ok || temLegado) {
    saida.textContent =
      "⚠ Extensão desatualizada em execução. Recarregue-a em chrome://extensions (↻) " +
      "e depois recarregue a página da Adalove.";
    return;
  }

  const quando = pong.ultimaCaptura
    ? new Date(pong.ultimaCaptura).toLocaleString("pt-BR")
    : "nunca — navegue na Vida Acadêmica da Adalove";
  saida.textContent = `v${pong.versao} ativa · ${pong.turmas} turma(s) · última captura: ${quando}`;
}

async function carregar() {
  const dados = await chrome.storage.local.get({
    capturas: {},
    turmaAtiva: null,
  });

  estado.capturas = dados.capturas;
  // Turma ativa: a última capturada (gravada pelo background) ou, na falta,
  // a primeira disponível.
  estado.turmaAtiva =
    dados.turmaAtiva && dados.capturas[dados.turmaAtiva]
      ? dados.turmaAtiva
      : Object.keys(dados.capturas)[0] || null;

  montarSeletorTurma();
  renderizarTudo();
  diagnosticar();
}

// Recarrega ao vivo quando o background grava novas capturas com o popup
// aberto (ex.: aluno navegando na Adalove com o popup fixado).
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === "local" && mudancas.capturas) {
    carregar();
  }
});

carregar();
