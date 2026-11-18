using Microsoft.AspNetCore.Mvc;
using System.Xml;

class XmlController : ControllerBase {
    [HttpPost("parse")]
    public XmlDocument Parse([FromBody] string payload) {
        var document = new XmlDocument { XmlResolver = new XmlUrlResolver() };
        document.LoadXml(payload);
        return document;
    }
}
