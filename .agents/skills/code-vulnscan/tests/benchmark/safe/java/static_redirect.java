// BENCHMARK: safe - fixed redirect
import jakarta.servlet.http.*;

public class SafeLoginServlet extends HttpServlet {
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        response.sendRedirect("/login");
    }
}
