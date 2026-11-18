using Microsoft.AspNetCore.Builder;

app.MapGet("/proxy", async (string target, HttpClient client) => {
    return await client.GetStringAsync(target);
});
