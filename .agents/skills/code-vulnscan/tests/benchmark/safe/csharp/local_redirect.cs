class LoginController : Controller {
    [HttpGet]
    public IActionResult Complete([FromQuery] string returnUrl) {
        if (!Url.IsLocalUrl(returnUrl)) return BadRequest();
        return Redirect(returnUrl);
    }
}
