class PreviewController : ControllerBase {
    [HttpGet]
    public object Preview([FromQuery] string content) {
        var encoded = HtmlEncoder.Default.Encode(content);
        return Html.Raw(encoded);
    }
}
