class ProxyController : ControllerBase {
    [HttpGet]
    public async Task<string> Get([FromQuery] string target) {
        var uri = new Uri(target);
        if (uri.Scheme != Uri.UriSchemeHttps || !AllowedHosts.Contains(uri.Host)) {
            throw new ArgumentException();
        }
        return await client.GetStringAsync(uri);
    }
}
