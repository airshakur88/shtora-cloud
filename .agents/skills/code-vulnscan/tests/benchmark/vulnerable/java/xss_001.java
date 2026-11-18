// BENCHMARK: vulnerable - xss
import jakarta.servlet.http.*;

public class SearchServlet extends HttpServlet {
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        String query = request.getParameter("q");
        response.getWriter().write("Results for " + query);
    }
}
