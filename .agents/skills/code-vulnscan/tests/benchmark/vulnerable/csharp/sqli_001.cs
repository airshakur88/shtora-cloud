using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

class SearchController : ControllerBase {
    [HttpGet("search")]
    public object Search([FromQuery] string term) {
        var command = new SqlCommand($"SELECT * FROM users WHERE name = '{term}'", connection);
        return command.ExecuteReader();
    }
}
