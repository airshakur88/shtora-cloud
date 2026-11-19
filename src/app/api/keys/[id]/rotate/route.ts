/**
 * POST /api/keys/[id]/rotate — removed with the unified tokens. Kept as a
 * stub answering 410 for every caller until the route is deleted.
 */
export async function POST(): Promise<Response> {
	return Response.json(
		{
			error: {
				message: "Unified tokens were removed. Use an API key.",
				type: "gone",
			},
		},
		{ status: 410 },
	);
}
