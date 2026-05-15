import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";

export async function GET(req: NextRequest) {
  const session = await auth();
  const orgId = (session?.user as any)?.organizationId;
  if (!orgId) return new NextResponse("Não autorizado", { status: 401 });

  // Pegar filtros da URL
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("user");
  const action = searchParams.get("action");
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  // Construir o WHERE idêntico ao da página
  const where: any = { organizationId: orgId };
  if (user) where.user = { name: { contains: user, mode: 'insensitive' } };
  if (action) where.action = action;
  if (start || end) {
    where.createdAt = {};
    if (start) where.createdAt.gte = new Date(start);
    if (end) where.createdAt.lte = new Date(end);
  }

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
      l.user.name || l.user.email,
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
  } catch (e) {
    return new NextResponse("Erro", { status: 500 });
  }
}