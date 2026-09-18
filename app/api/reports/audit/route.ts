import { NextRequest, NextResponse } from "next/server";
import { currentActor } from "@/lib/current-actor";
import { auditFilter } from "@/lib/domain/audit-filter";
import { isOrgAdmin } from "@/lib/domain/roles";
import { prisma } from "@/lib/prisma";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    const actor = await currentActor();
    if (!isOrgAdmin(actor.role)) return new NextResponse("Não autorizado", { status: 403 });
    orgId = actor.organizationId;
  } catch {
    return new NextResponse("Não autorizado", { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const where = auditFilter(orgId, {
    user: searchParams.get("user"),
    action: searchParams.get("action"),
    start: searchParams.get("start"),
    end: searchParams.get("end"),
  });

  try {
    const logs = await prisma.auditLog.findMany({
      where,
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });

    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Relatório de Auditoria Filtrado", 14, 15);
    doc.setFontSize(8);
    doc.text(`Gerado em: ${format(new Date(), "dd/MM/yyyy HH:mm")}`, 14, 22);

    const rows = logs.map(l => [
      format(new Date(l.createdAt), "dd/MM/yyyy HH:mm"),
      l.user?.name || l.user?.email || "Integração",
      l.action,
      l.entity,
      l.details || ""
    ]);

    autoTable(doc, {
      head: [["Data", "Usuário", "Ação", "Entidade", "Detalhes"]],
      body: rows,
      startY: 25,
      styles: { fontSize: 7 },
      headStyles: { fillColor: [51, 65, 85] },
      columnStyles: { 4: { cellWidth: 70 } }
    });

    const pdfOutput = doc.output("arraybuffer");
    return new NextResponse(pdfOutput, {
      headers: { "Content-Type": "application/pdf" }
    });
  } catch {
    return new NextResponse("Erro", { status: 500 });
  }
}
