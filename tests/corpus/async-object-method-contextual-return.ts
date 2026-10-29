type Text = { type: "text"; text: string; textSignature?: string };
type Image = { type: "image"; data: string; mimeType: string };
interface ToolResult<D> { content: (Text | Image)[]; details: D; isError?: boolean }
interface ToolDefinition<D> { name: string; execute(id: string, q: string): Promise<ToolResult<D>> }
function define(): ToolDefinition<{ loaded: string[] }> {
	return {
		name: "search",
		async execute(_id, q) {
			const text = `found ${q}`;
			return { content: [{ type: "text", text }], details: { loaded: [q] } };
		},
	};
}
define().execute("1", "x").then((r) => console.log(JSON.stringify(r)));
