export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "prisim-r2",
      runtime: "workers",
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
