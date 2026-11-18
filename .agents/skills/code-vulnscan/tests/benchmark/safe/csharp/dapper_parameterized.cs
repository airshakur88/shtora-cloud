class SearchController : ControllerBase {
    [HttpGet]
    public object Search([FromQuery] string term) {
        return connection.Query<User>(
            "SELECT * FROM users WHERE name = @term", new { term });
    }
}
