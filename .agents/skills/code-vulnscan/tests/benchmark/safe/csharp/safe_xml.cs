class XmlController : ControllerBase {
    [HttpPost]
    public void Parse([FromBody] string payload) {
        var settings = new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null
        };
        using var reader = XmlReader.Create(new StringReader(payload), settings);
    }
}
