export const runtime = "edge";

export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "prisim-r2",
      runtime: "edge",
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
