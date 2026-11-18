// BENCHMARK: vulnerable - open_redirect
import jakarta.servlet.http.*;

public class LoginServlet extends HttpServlet {
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        String next = request.getParameter("next");
        response.sendRedirect(next);
    }
}
