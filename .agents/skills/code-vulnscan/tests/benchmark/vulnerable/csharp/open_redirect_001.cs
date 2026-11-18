using Microsoft.AspNetCore.Mvc;

class LoginController : Controller {
    [HttpGet("complete")]
    public IActionResult Complete([FromQuery] string returnUrl) {
        return Redirect(returnUrl);
    }
}
