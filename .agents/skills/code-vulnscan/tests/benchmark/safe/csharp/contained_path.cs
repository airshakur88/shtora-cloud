class FileController : ControllerBase {
    [HttpGet]
    public string Read([FromQuery] string name) {
        var root = Path.GetFullPath(storageRoot) + Path.DirectorySeparatorChar;
        var candidate = Path.GetFullPath(Path.Combine(root, name));
        if (!candidate.StartsWith(root, StringComparison.Ordinal)) {
            throw new UnauthorizedAccessException();
        }
        return File.ReadAllText(candidate);
    }
}
