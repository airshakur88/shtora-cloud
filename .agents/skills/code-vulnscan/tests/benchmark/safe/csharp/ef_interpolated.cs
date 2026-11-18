class SearchController : ControllerBase {
    [HttpGet]
    public object Search([FromQuery] string term) {
        return context.Users.FromSqlInterpolated(
            $"SELECT * FROM users WHERE name = {term}").ToList();
    }
}
