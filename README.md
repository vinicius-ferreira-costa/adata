# Adata

Extensão do Google Chrome (Manifest V3) que captura, organiza e exporta os
dados acadêmicos da plataforma **Adalove** do Inteli
(`adalove.inteli.edu.br`). Todo o processamento acontece localmente —
**nenhum dado do aluno sai do navegador**.

> **Aviso**: o Adata é uma ferramenta independente, feita por estudantes,
> sem vínculo oficial com o Inteli ou com a plataforma Adalove.

## Instalação em modo desenvolvedor

1. Clone/baixe este repositório.
2. Abra `chrome://extensions` no Chrome.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto
   (a que contém o `manifest.json`).
5. Navegue pela Adalove normalmente. A extensão captura os dados em segundo
   plano; abra o popup (ícone da extensão) para ver, filtrar e exportar.

> Dica de diagnóstico: em `chrome://extensions`, clique em
> **service worker** no card da Adata para abrir o console do background.
> Cada captura loga o caminho do payload que funcionou
> (ex.: `[Adata] 42 itens via "payload.data" → autoestudos`).

## Problemas comuns

**"A extensão parou de puxar os dados" depois de atualizar os arquivos.**
Extensão sem compactação NÃO aplica mudanças de `background.js` e dos
content scripts automaticamente. Sempre, nesta ordem:

1. `chrome://extensions` → Adata → botão recarregar (↻);
2. recarregue (F5) as abas da Adalove abertas — o content script antigo
   morre com a atualização ("Extension context invalidated") e só volta com
   o refresh da página.

O rodapé do popup mostra o autodiagnóstico: versão ativa do worker, turmas
capturadas e última captura. Se aparecer "Extensão desatualizada em
execução", é exatamente este caso.

## Rodando os testes

Os módulos de lógica (`normalize.js`, `export.js`, `notas.js`) são puros —
sem nenhuma Chrome API — e rodam isolados em Node:

```bash
npm install
npm test
```

## Arquitetura do fluxo de dados

```
Página Adalove (contexto MAIN)
│
│  src/interceptor.js
│  Monkey-patch de fetch/XMLHttpRequest instalado em document_start,
│  antes do bundle da Adalove rodar. Filtra apiv2.inteli.edu.br,
│  clona a Response (o corpo só pode ser lido uma vez) e repassa o
│  JSON cru via window.postMessage. A página sempre recebe a
│  resposta original, intacta.
│
│  CAPTURA ATIVA: além da interceptação passiva, a cada carga da
│  Adalove o interceptor dispara ele mesmo /sections e
│  /sections/{uuid}/userdata com a sessão do próprio aluno — a
│  resposta passa pelo fetch já interceptado e cai no fluxo normal.
│  Garante dados frescos em qualquer recarga, sem depender de o
│  aluno visitar a Vida Acadêmica.
▼
Content script (mundo isolado)
│
│  src/content.js
│  Valida a origem da mensagem (event.source === window +
│  identificador ADATA_INTERCEPTOR, contra spoofing) e repassa ao
│  service worker via chrome.runtime.sendMessage.
▼
Service worker
│
│  src/background.js
│  extrairAtividades() procura a lista de atividades de forma
│  defensiva (vários caminhos comuns + varredura recursiva), exigindo
│  studentActivityUuid nos itens — outros endpoints também devolvem
│  arrays de objetos (turmas, posts, notificações) e não podem entrar.
│  Agrupa POR TURMA (sectionUuid) e faz MERGE por studentActivityUuid
│  — capturas se acumulam, nunca se perdem ao navegar, e módulos
│  diferentes não misturam médias. Atualiza o badge do ícone.
▼
chrome.storage.local
│
│  capturas: { [sectionUuid]: { rotulo, atividades (uuid → bruto),
│  statusAluno, ultimaCaptura } }, turmaAtiva, urlsCapturadas.
▼
Popup
│
│  src/popup.js + módulos puros:
│  - normalize.js  → dedupe, eixo (cascata de 3 fontes), semana, ordenação
│  - export.js     → CSV (escape RFC 4180) e Markdown agrupado por semana
│  - notas.js      → médias, categorias, participação, simulação
│                    direta e reversa, presença
▼
Exportação: Blob + URL.createObjectURL + <a download>
(sem a permissão "downloads" — menos atrito na revisão da Web Store)
```

### Contrato real da API (mapeado ao vivo)

`GET https://apiv2.inteli.edu.br/sections/{uuid}/userdata` devolve, num único
payload, todos os cards do módulo:

```
{ section, roles, students, activities: [...], folders, group, studentStatus }
```

Cada item de `activities` tem, entre outros: `studentActivityUuid`, `caption`
(título), `description`, `folderCaption` ("Semana NN"), `professorName`,
`axisCaption` (sigla do eixo: COM/MTF/NEG/UEX/LID ou null), `type`
(11 = autoestudo/ponderada, 21 = artefato, 1 = encontro, 2 = instrução),
`gradeWeight` (peso; 0 = não vale nota) e `gradeResult` (nota como string;
`-1` = não lançada). `studentStatus` traz as métricas oficiais
(`evaluationResult`, `doneEvaluationResult`, `doneEvaluateResultFactor`,
`absencesPercentage`, `studentStatus`).

A média da Adalove foi validada contra a plataforma:
`Σ(gradeResult × gradeWeight) / Σ(gradeWeight)` reproduz exatamente o valor
exibido (duas turmas conferidas: 8.53 e 7.80). Por isso a classificação é
por item (`gradeWeight > 0` ⇒ vale nota) e não por payload.

**Frequência**: cada card de encontro traz `attendance1..3` (três check-ins
por dia de aula) com 10 = presente, 0 = falta, -1 = não se aplica. O total de
check-ins varia por turma/módulo; o limite de faltas é sempre **20% do total
daquela turma**, calculado sobre os dados capturados. A regra foi calibrada
contra a própria Adalove — por exemplo, num módulo específico com 135
check-ins, a plataforma exibia limite de 27 faltas (27/135 = 20%) e cada
check-in valendo 1/135 = 0,74% da presença. Os números do exemplo são desse
módulo, não constantes.

### Decisões de projeto

- **Dados brutos no storage, normalização no popup.** Guardar o JSON cru
  permite reprocessar e evoluir a normalização sobre capturas antigas sem
  exigir recaptura do aluno.
- **Eixo nunca é chutado.** A cascata é: campo estruturado do payload (só se
  for um dos cinco eixos válidos) → mapa professor→eixo (rede de segurança
  frágil, documentada em `normalize.js`) → `"Orientação"` (na API real, card
  sem eixo é atividade de orientação).
- **Permissões mínimas.** Só `storage` + host permissions dos dois domínios
  do Inteli. Sem `downloads`, sem `history`, sem `tabs`.

## v4.1 — entregue

- **Junção nota↔instrução**: cada avaliação da aba Notas ganha o link e a
  descrição do seu card de instrução. No contrato real da API a ponderada É
  o próprio card (mesmo `studentActivityUuid`), então a 1ª camada casa por
  uuid; `chaveJuncao()` (título normalizado) fica como 2ª camada para o dia
  em que notas e instruções vierem em registros separados.
- **Gráfico de evolução da média**: curva SVG (vanilla, sem lib) da média
  ponderada acumulada semana a semana, na aba Notas
  (`evolucaoPorSemana()` em `notas.js`).
- **Captura ativa**: dados frescos a cada recarga da Adalove (ver
  arquitetura acima).
- **Eixo "Orientação"**: cards sem `axisCaption` são atividades de
  orientação — sexto balde de filtro, no lugar do antigo "Indefinido"
  (registro histórico: até a v4.0 a cascata terminava em "Indefinido").

## Licença

Este projeto está sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para
os termos completos.
