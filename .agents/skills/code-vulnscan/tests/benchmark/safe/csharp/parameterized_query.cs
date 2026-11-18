using Microsoft.Data.SqlClient;

class SearchController : ControllerBase {
    [HttpGet]
    public object Search([FromQuery] string term) {
        var command = new SqlCommand("SELECT * FROM users WHERE name = @term", connection);
        command.Parameters.Add("@term", SqlDbType.NVarChar, 200).Value = term;
        return command.ExecuteReader();
    }
}
