using Microsoft.AspNetCore.Mvc;
using System.Runtime.Serialization.Formatters.Binary;

class ImportController : ControllerBase {
    [HttpPost("import")]
    public object Import([FromBody] Stream payload) {
        return new BinaryFormatter().Deserialize(payload);
    }
}
