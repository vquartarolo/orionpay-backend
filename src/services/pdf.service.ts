import PDFDocument from "pdfkit";
import type {
  UserReportData,
  RiskReportData,
  FinancialReportData,
  AuditTrailData,
} from "./compliance-report.service";

// ── Branding ──────────────────────────────────────────────────────────────────

const BRAND = {
  primary:  "#2D8659",
  dark:     "#0F172A",
  gray:     "#64748B",
  lightGray:"#94A3B8",
  border:   "#E2E8F0",
  text:     "#1E293B",
  white:    "#FFFFFF",
  amber:    "#D97706",
  red:      "#DC2626",
};

const PAGE_MARGIN = 50;
const PAGE_WIDTH  = 595.28; // A4
const CONTENT_W   = PAGE_WIDTH - PAGE_MARGIN * 2;

// ── Helpers de layout ─────────────────────────────────────────────────────────

function makeDoc(): PDFKit.PDFDocument {
  return new PDFDocument({ margin: PAGE_MARGIN, size: "A4", bufferPages: true });
}

function fmtBRL(v: number): string {
  return Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function drawHeader(doc: PDFKit.PDFDocument, reportTitle: string, subtitle?: string): void {
  // Green header band
  doc.rect(0, 0, PAGE_WIDTH, 72).fill(BRAND.primary);

  // OrionPay brand
  doc.fontSize(18).font("Helvetica-Bold").fillColor(BRAND.white)
     .text("ORIONPAY", PAGE_MARGIN, 18, { continued: false });

  doc.fontSize(8).font("Helvetica").fillColor("rgba(255,255,255,0.75)")
     .text("Infraestrutura Financeira — Documento Confidencial", PAGE_MARGIN, 40);

  // Generated timestamp — right side
  doc.fontSize(8).fillColor("rgba(255,255,255,0.75)")
     .text(`Gerado em: ${fmtDate(new Date().toISOString())}`, PAGE_MARGIN, 55, { align: "right" });

  // Report title below header
  doc.fillColor(BRAND.dark)
     .fontSize(17).font("Helvetica-Bold")
     .text(reportTitle, PAGE_MARGIN, 90);

  if (subtitle) {
    doc.fontSize(10).font("Helvetica").fillColor(BRAND.gray)
       .text(subtitle, PAGE_MARGIN, 113);
    doc.moveDown(1.5);
  } else {
    doc.moveDown(1);
  }
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.8);
  const y = doc.y;
  doc.rect(PAGE_MARGIN, y, CONTENT_W, 22).fill("#F1F5F9");
  doc.fontSize(10).font("Helvetica-Bold").fillColor(BRAND.primary)
     .text(title.toUpperCase(), PAGE_MARGIN + 8, y + 6);
  doc.moveDown(1);
}

function kv(doc: PDFKit.PDFDocument, label: string, value: string, labelColor?: string): void {
  const y = doc.y;
  doc.fontSize(9).font("Helvetica-Bold").fillColor(labelColor ?? BRAND.gray)
     .text(label, PAGE_MARGIN, y, { width: 160, continued: false });
  doc.fontSize(9).font("Helvetica").fillColor(BRAND.text)
     .text(value, PAGE_MARGIN + 165, y, { width: CONTENT_W - 165 });
}

function divider(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.4);
  doc.rect(PAGE_MARGIN, doc.y, CONTENT_W, 0.5).fill(BRAND.border);
  doc.moveDown(0.4);
}

type TableRow = string[];

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: TableRow[],
  colWidths?: number[]
): void {
  const widths = colWidths ?? headers.map(() => CONTENT_W / headers.length);
  const rowH   = 18;
  const cellPad = 5;

  // Header row
  let x = PAGE_MARGIN;
  const headerY = doc.y;
  doc.rect(PAGE_MARGIN, headerY, CONTENT_W, rowH).fill("#334155");
  for (let i = 0; i < headers.length; i++) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor(BRAND.white)
       .text(headers[i], x + cellPad, headerY + cellPad, {
         width: widths[i] - cellPad * 2,
         lineBreak: false,
       });
    x += widths[i];
  }
  doc.y = headerY + rowH;

  // Data rows
  for (let ri = 0; ri < rows.length; ri++) {
    // Page break guard
    if (doc.y + rowH > doc.page.height - 60) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
    }

    const rowY = doc.y;
    const bg   = ri % 2 === 0 ? BRAND.white : "#F8FAFC";
    doc.rect(PAGE_MARGIN, rowY, CONTENT_W, rowH).fill(bg);
    // Border
    doc.rect(PAGE_MARGIN, rowY, CONTENT_W, rowH).stroke(BRAND.border);

    x = PAGE_MARGIN;
    for (let ci = 0; ci < rows[ri].length; ci++) {
      doc.fontSize(8).font("Helvetica").fillColor(BRAND.text)
         .text(String(rows[ri][ci] ?? "—"), x + cellPad, rowY + cellPad, {
           width: widths[ci] - cellPad * 2,
           lineBreak: false,
         });
      x += widths[ci];
    }
    doc.y = rowY + rowH;
  }

  doc.moveDown(0.5);
}

function addFooter(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.rect(0, doc.page.height - 36, PAGE_WIDTH, 36).fill("#F8FAFC");
    doc.fontSize(7).font("Helvetica").fillColor(BRAND.lightGray)
       .text(
         `OrionPay — Documento gerado automaticamente • Página ${i + 1} de ${range.count}`,
         PAGE_MARGIN,
         doc.page.height - 22,
         { align: "center" }
       );
  }
}

// ── PDF 1 — Relatório de Usuário ──────────────────────────────────────────────

export function buildUserReportPDF(data: UserReportData): PDFKit.PDFDocument {
  const doc = makeDoc();

  drawHeader(
    doc,
    "Relatório de Usuário — Compliance",
    `ID: ${data.user.id} • ${data.user.name} • ${data.user.email}`
  );

  // ── Dados do usuário ──
  sectionTitle(doc, "Identificação do Usuário");
  kv(doc, "Nome",           data.user.name);         divider(doc);
  kv(doc, "E-mail",         data.user.email);        divider(doc);
  kv(doc, "Documento",      data.user.document);     divider(doc);
  kv(doc, "Perfil",         data.user.role);         divider(doc);
  kv(doc, "Status",         data.user.status);       divider(doc);
  kv(doc, "Status da conta",data.user.accountStatus);divider(doc);
  kv(doc, "Criado em",      fmtDate(data.user.createdAt));

  // ── KYC ──
  if (data.kyc) {
    sectionTitle(doc, "KYC / Verificação de Identidade");
    kv(doc, "Status KYC",    data.kyc.status);           divider(doc);
    kv(doc, "Tipo",          data.kyc.kycType ?? "—");   divider(doc);
    kv(doc, "Nome completo", data.kyc.fullName);          divider(doc);
    kv(doc, "Documento",     data.kyc.documentNumber);    divider(doc);
    kv(doc, "PEP",           data.kyc.pepStatus,         data.kyc.pepStatus === "confirmed" ? BRAND.red : undefined); divider(doc);
    kv(doc, "Sanções",       data.kyc.sanctionsStatus,   data.kyc.sanctionsStatus === "confirmed" ? BRAND.red : undefined); divider(doc);
    kv(doc, "Risco AML",     data.kyc.amlRiskLevel ?? "—",data.kyc.amlRiskLevel === "high" ? BRAND.red : undefined); divider(doc);
    kv(doc, "Enviado em",    fmtDate(data.kyc.submittedAt)); divider(doc);
    kv(doc, "Revisado em",   fmtDate(data.kyc.reviewedAt));
  }

  // ── Resumo de risco ──
  sectionTitle(doc, "Resumo de Risco");
  kv(doc, "Total de verificações", String(data.riskSummary.totalChecks));   divider(doc);
  kv(doc, "Score médio",           String(data.riskSummary.avgScore));      divider(doc);
  kv(doc, "Score mais alto",       String(data.riskSummary.highestScore));  divider(doc);
  kv(doc, "Bloqueados",            String(data.riskSummary.blocked),        BRAND.red); divider(doc);
  kv(doc, "Em revisão",            String(data.riskSummary.reviewed),       BRAND.amber); divider(doc);
  kv(doc, "Permitidos",            String(data.riskSummary.allowed));

  if (data.riskSummary.flags.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(BRAND.gray).text("Flags detectadas:");
    doc.fontSize(8).font("Helvetica").fillColor(BRAND.text)
       .text(data.riskSummary.flags.join(" • "), { width: CONTENT_W });
  }

  // ── Transações ──
  sectionTitle(doc, "Resumo Financeiro");
  kv(doc, "Total depositado",  `R$ ${fmtBRL(data.transactions.totalDeposits)}`); divider(doc);
  kv(doc, "Total sacado",      `R$ ${fmtBRL(data.transactions.totalCashouts)}`); divider(doc);
  kv(doc, "Total em taxas",    `R$ ${fmtBRL(data.transactions.totalFees)}`);     divider(doc);
  kv(doc, "Nº de saques",      String(data.transactions.cashoutCount));          divider(doc);
  kv(doc, "Última atividade",  fmtDate(data.lastActivity));

  // ── Eventos de auditoria ──
  if (data.auditEvents.length > 0) {
    sectionTitle(doc, `Últimos Eventos de Auditoria (${data.auditEvents.length})`);
    drawTable(
      doc,
      ["Ação", "Ator", "Data/Hora"],
      data.auditEvents.slice(0, 30).map((e) => [e.action, e.actorRole, fmtDate(e.timestamp)]),
      [220, 120, 155]
    );
  }

  addFooter(doc);
  return doc;
}

// ── PDF 2 — Relatório de Risco ────────────────────────────────────────────────

export function buildRiskReportPDF(data: RiskReportData): PDFKit.PDFDocument {
  const doc = makeDoc();

  drawHeader(
    doc,
    "Relatório de Risco — AML / Compliance",
    `Período: ${fmtDate(data.period.from)} — ${fmtDate(data.period.to)}`
  );

  // Sumário executivo
  sectionTitle(doc, "Sumário Executivo");
  kv(doc, "Total de verificações",   String(data.summary.totalChecks));    divider(doc);
  kv(doc, "Operações bloqueadas",    String(data.summary.blocked),          BRAND.red);    divider(doc);
  kv(doc, "Operações em revisão",    String(data.summary.reviewed),         BRAND.amber);  divider(doc);
  kv(doc, "Operações permitidas",    String(data.summary.allowed));         divider(doc);
  kv(doc, "Score médio global",      String(data.summary.avgScore));        divider(doc);
  kv(doc, "Usuários alto risco AML", String(data.summary.highRiskCount),    BRAND.red);    divider(doc);
  kv(doc, "PEP confirmados",         String(data.summary.pepCount),         BRAND.red);    divider(doc);
  kv(doc, "Sanções confirmadas",     String(data.summary.sanctionsCount),   BRAND.red);

  // Top usuários de risco
  if (data.topRiskUsers.length > 0) {
    sectionTitle(doc, `Usuários de Maior Risco (Top ${data.topRiskUsers.length})`);
    drawTable(
      doc,
      ["Nome", "E-mail", "Score máx.", "Bloqueios", "PEP", "Sanções"],
      data.topRiskUsers.map((u) => [
        u.name,
        u.email,
        String(u.highestScore),
        String(u.blockCount),
        u.pepStatus,
        u.sanctionsStatus,
      ]),
      [110, 140, 60, 60, 80, 80]
    );
  }

  // Breakdown de regras
  if (data.ruleBreakdown.length > 0) {
    sectionTitle(doc, "Breakdown de Regras Disparadas");
    drawTable(
      doc,
      ["Regra / Motivo", "Ocorrências"],
      data.ruleBreakdown.slice(0, 20).map((r) => [r.rule, String(r.count)]),
      [420, 75]
    );
  }

  // Bloqueios recentes
  if (data.recentBlocks.length > 0) {
    sectionTitle(doc, `Bloqueios Recentes (${data.recentBlocks.length})`);
    drawTable(
      doc,
      ["ID Usuário", "Score", "Principal motivo", "Data"],
      data.recentBlocks.map((b) => [
        b.userId.slice(-8).toUpperCase(),
        String(b.score),
        b.reasons[0] ?? "—",
        fmtDate(b.createdAt),
      ]),
      [80, 50, 250, 115]
    );
  }

  addFooter(doc);
  return doc;
}

// ── PDF 3 — Relatório Financeiro ──────────────────────────────────────────────

export function buildFinancialReportPDF(data: FinancialReportData): PDFKit.PDFDocument {
  const doc = makeDoc();

  drawHeader(
    doc,
    "Relatório Financeiro — Contabilidade",
    `Período: ${fmtDate(data.period.from)} — ${fmtDate(data.period.to)}`
  );

  // DRE
  sectionTitle(doc, "Demonstração de Resultado (DRE)");
  kv(doc, "Receita bruta (taxas)", `R$ ${fmtBRL(data.incomeStatement.revenue)}`);  divider(doc);
  kv(doc, "Despesas operacionais", `R$ ${fmtBRL(data.incomeStatement.expenses)}`); divider(doc);
  kv(doc, "Lucro líquido",         `R$ ${fmtBRL(data.incomeStatement.netProfit)}`);divider(doc);
  kv(doc, "Margem líquida",        `${data.incomeStatement.margin}%`);

  // Fluxo de caixa
  sectionTitle(doc, "Fluxo de Caixa");
  kv(doc, "Entradas (depósitos)", `R$ ${fmtBRL(data.cashFlow.inflow)}`);  divider(doc);
  kv(doc, "Saídas (saques)",      `R$ ${fmtBRL(data.cashFlow.outflow)}`); divider(doc);
  kv(doc, "Taxas retidas",        `R$ ${fmtBRL(data.cashFlow.fees)}`);    divider(doc);
  kv(doc, "Fluxo líquido",        `R$ ${fmtBRL(data.cashFlow.netFlow)}`);

  // Balancete
  if (data.trialBalance.accounts.length > 0) {
    sectionTitle(doc, "Balancete (Trial Balance)");

    const balanceIndicator = data.trialBalance.isBalanced ? "✓ BALANCEADO" : "✗ DESBALANCEADO";
    doc.fontSize(9).font("Helvetica-Bold")
       .fillColor(data.trialBalance.isBalanced ? BRAND.primary : BRAND.red)
       .text(balanceIndicator, { align: "right" });
    doc.moveDown(0.5);

    drawTable(
      doc,
      ["Conta", "Categoria", "Débito (R$)", "Crédito (R$)", "Saldo (R$)"],
      data.trialBalance.accounts.map((a) => [
        a.label,
        a.categoryLabel,
        fmtBRL(a.totalDebit),
        fmtBRL(a.totalCredit),
        fmtBRL(a.balance),
      ]),
      [155, 80, 90, 90, 80]
    );

    doc.fontSize(8).font("Helvetica-Bold").fillColor(BRAND.text)
       .text(
         `Total: Débito R$ ${fmtBRL(data.trialBalance.totals.totalDebit)} | ` +
         `Crédito R$ ${fmtBRL(data.trialBalance.totals.totalCredit)}`,
         { align: "right" }
       );
  }

  addFooter(doc);
  return doc;
}

// ── PDF 4 — Trilha de Auditoria ───────────────────────────────────────────────

export function buildAuditTrailPDF(data: AuditTrailData): PDFKit.PDFDocument {
  const doc = makeDoc();

  drawHeader(
    doc,
    "Trilha de Auditoria — Compliance",
    `Período: ${fmtDate(data.period.from)} — ${fmtDate(data.period.to)} • ${data.totalEvents} eventos`
  );

  sectionTitle(doc, "Informações do Relatório");
  kv(doc, "Total de eventos",  String(data.totalEvents));       divider(doc);
  kv(doc, "Filtro por entidade", data.entityId ?? "Todos");     divider(doc);
  kv(doc, "Gerado em",         fmtDate(data.generatedAt));

  sectionTitle(doc, `Eventos (exibindo ${Math.min(data.events.length, 500)})`);
  drawTable(
    doc,
    ["Ação", "Ator", "Tipo alvo", "ID Alvo", "Data/Hora"],
    data.events.slice(0, 500).map((e) => [
      e.action,
      e.actorRole,
      e.targetType,
      e.targetId ? e.targetId.slice(-8).toUpperCase() : "—",
      fmtDate(e.timestamp),
    ]),
    [145, 80, 75, 70, 125]
  );

  addFooter(doc);
  return doc;
}
