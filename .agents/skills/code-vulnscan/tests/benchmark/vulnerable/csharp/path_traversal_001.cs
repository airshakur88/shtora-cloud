using Microsoft.AspNetCore.Mvc;
using System.IO;

class FileController : ControllerBase {
    [HttpGet("read")]
    public string Read([FromQuery] string name) {
        var candidate = Path.Combine(storageRoot, name);
        return File.ReadAllText(candidate);
    }
}
